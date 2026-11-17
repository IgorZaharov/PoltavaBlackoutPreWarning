import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, AlertTriangle, Bell, ExternalLink, Globe, HelpCircle, Loader2, Pencil, Plus, RotateCcw, Send, Sliders, Star, Trash2, Vibrate, Volume2, X, Zap, RefreshCw, GripVertical, Clock } from 'lucide-react';
import { Language, UserSettings } from '../types';
import { QUEUES, DEFAULT_POE_URL, verifyPoeSite } from '../services/poeScheduleSync';
import {
  checkAddress,
  ensurePoeDirectory,
  fetchHousesForStreet,
  findSettlementById,
  findStreetById,
  getHousesForStreet,
  getRems,
  getSettlementsForRem,
  refreshSettlements,
  refreshStreets,
  settlementChoices as settlementChoicesOf,
  updateDirectory,
  getStreetsForSettlement,
  type PoeHouseLookupResult,
  type PoeBranchOption,
  type PoeSettlementOption,
  type PoeStreetOption
} from '../services/poeAddressLookup';
import { getSubscriptionSync, type SyncResult } from '../services/subscriptionSync';
import { companyChoices, ensurePoeQueues, queuesFor, type CompanyChoice } from '../services/poeQueues';
import { QueueChoiceChips, hintCaption } from './QueueChoiceChips';
import {
  ERR_DUPLICATE,
  ERR_LIMIT,
  MAX_ITEMS,
  MAX_LABEL_LENGTH,
  noAlertsCaption,
  defaultLabel,
  displayLabel,
  remove as removeItem,
  rename as renameItem,
  move as moveItem,
  setEmergency,
  setPlanned,
  setPrimary,
  type Subscription,
} from '../core/subscriptions';
import {
  addCompanyQueue,
  addressLimitReached,
  addressesCount,
  addressesLeft,
  plannedDesc,
  QUEUE_HELP_URL,
  queueHelpSteps,
  rangeMinutes,
  removeConfirmBody,
  translations,
} from '../services/i18n';
import { HouseKey } from '../core/addressKeys';
import { GlassCard, TEXT_SECONDARY, TEXT_TERTIARY } from './GlassCard';
import { SearchablePickerField, type PickerItem } from './SearchablePickerField';
import { ModalPortal } from './ModalPortal';

/** Presets for "warn me N minutes before". 5 and 10 work: alarms are exact, only the site refresh is bounded. */
export const ADVANCE_PRESETS = [5, 10, 15, 20, 30, 45, 60, 90, 120, 180, 240];
/** Presets for the site check (Android never runs periodic work more often than every 15 minutes). */
export const REFRESH_PRESETS = [15, 30, 60, 120, 180, 240];

type RefreshStatus = 'SUCCESS' | 'NO_INTERNET' | 'NO_QUEUES_FOUND';

interface SettingsViewProps {
  settings: UserSettings;
  lang: 'uk' | 'en';
  onUpdateSettings: (newSettings: UserSettings) => void;
  onSendTestAlert: () => void;
  onForceRefresh: () => Promise<RefreshStatus | void> | void;
  /** A refresh is running: the refresh button's icon rotates and taps are ignored. */
  isRefreshing?: boolean;
  onResetDefaults: () => void;
  autoOpenQueueHelp?: boolean;
  onQueueHelpOpened?: () => void;
  onNavigateToMain?: () => void;
}

const displayName = (o: { nameUk: string; nameEn: string }, lang: 'uk' | 'en') => (lang === 'uk' ? o.nameUk : o.nameEn);
// Settlements and streets keep their Ukrainian names in both languages: POE lists have no English names
// (mirrors SettingsScreen.kt).
const placeName = (o: { nameUk: string }) => o.nameUk;
/** First-launch cascade: Полтавська об'єднана філія (spec/branches.json) and місто Полтава (POE city_id 11389). */
const DEFAULT_BRANCH = 'poltavska';
const DEFAULT_SETTLEMENT = '11389';
const sameHouse = (a: string, b: string) => a.toLowerCase() === b.toLowerCase() || (HouseKey.of(a) !== '' && HouseKey.of(a) === HouseKey.of(b));

// ---------------------------------------------------------------------------------------------
// Small building blocks
// ---------------------------------------------------------------------------------------------

const fieldClass =
  'min-h-14 w-full cursor-pointer rounded-2xl border border-white/20 bg-white/[0.08] px-4 py-2 text-base font-medium text-white focus:border-[#FF5E3A] focus:outline-none focus-visible:outline-2 focus-visible:outline-[#FF5E3A]';

/** A labelled switch row: the whole row is the toggle target (role switch, aria-checked), 48 px high at least. */
const SwitchRow: React.FC<{
  icon: React.ReactNode;
  title: string;
  hint?: string;
  checked: boolean;
  enabled?: boolean;
  onToggle: () => void;
  testId: string;
  rowTestId?: string;
  titleClassName?: string;
  /** Marks the switch for the first-run tour (CoachTour). */
  tour?: string;
}> = ({ icon, title, hint, checked, enabled = true, onToggle, testId, rowTestId, titleClassName = '', tour }) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    aria-disabled={!enabled}
    data-testid={testId}
    data-tour={tour}
    disabled={!enabled}
    onClick={onToggle}
    className={`flex min-h-12 w-full items-center gap-3 text-left ${enabled ? 'cursor-pointer' : 'cursor-not-allowed'}`}
  >
    <span data-testid={rowTestId} className="flex min-w-0 flex-1 items-center gap-3">
      <span className="shrink-0" aria-hidden="true">
        {icon}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className={`text-base font-bold leading-[23px] ${enabled ? 'text-white' : 'text-white/50'} ${titleClassName}`}>{title}</span>
        {hint && <span className={`text-[13px] font-medium leading-[19px] ${enabled ? TEXT_SECONDARY : TEXT_TERTIARY}`}>{hint}</span>}
      </span>
    </span>
    <span
      aria-hidden="true"
      className={`flex h-[31px] w-[51px] shrink-0 items-center rounded-full p-[2px] transition-colors duration-200 motion-reduce:transition-none ${
        checked ? (enabled ? 'bg-[#FF5E3A] shadow-inner' : 'bg-[#FF5E3A]/30') : enabled ? 'border border-white/10 bg-white/15' : 'bg-white/10'
      }`}
    >
      <span
        className={`h-[27px] w-[27px] rounded-full bg-white shadow-[0_3px_8px_rgba(0,0,0,0.25),0_1px_1px_rgba(0,0,0,0.16)] transition-transform duration-200 motion-reduce:transition-none ${
          checked ? 'translate-x-[20px]' : 'translate-x-0'
        } ${enabled ? '' : 'opacity-60'}`}
      />
    </span>
  </button>
);

const Divider = () => <div className="h-px w-full bg-white/10" />;

const Overline: React.FC<{ children: React.ReactNode; className?: string }> = ({ children, className = '' }) => (
  <span className={`text-xs font-bold uppercase leading-[17px] tracking-[0.05em] text-white ${className}`}>{children}</span>
);

const ActionButton: React.FC<{
  text: string;
  icon?: React.ReactNode;
  filled?: boolean;
  subdued?: boolean;
  onClick: () => void;
  testId?: string;
  /** Work is running: taps are ignored and [busyText] is announced (the caller spins the icon). */
  busy?: boolean;
  busyText?: string;
}> = ({ text, icon, filled = false, subdued = false, onClick, testId, busy = false, busyText }) => (
  <button
    type="button"
    data-testid={testId}
    onClick={onClick}
    disabled={busy}
    aria-busy={busy || undefined}
    className={`flex h-full min-h-12 disabled:cursor-default w-full cursor-pointer items-center justify-center gap-2 rounded-2xl px-3 py-2.5 text-center text-sm leading-5 transition-colors focus-visible:outline-2 focus-visible:outline-white ${
      filled
        ? 'bg-[#FF5E3A] font-bold text-white shadow-md shadow-[#FF5E3A]/20 hover:bg-[#ff4b24]'
        : subdued
        ? 'border border-white/10 font-semibold text-[#BAE6FD]/90 hover:bg-white/5 hover:text-white'
        : 'border border-white/15 bg-white/10 font-semibold text-white hover:bg-white/20'
    }`}
  >
    {icon}
    <span>{text}</span>
    {busy && busyText && <span className="sr-only">{busyText}</span>}
  </button>
);

/** Loading flags of one level of the REM, city, street, house cascade; `retry` re-runs its fetch with forceRefresh. */
interface LevelState {
  loading: boolean;
  failed: boolean;
  retry: number;
}
const initialLevel: LevelState = { loading: false, failed: false, retry: 0 };

// ---------------------------------------------------------------------------------------------
// Settings screen
// ---------------------------------------------------------------------------------------------

export const SettingsView: React.FC<SettingsViewProps> = ({
  settings,
  lang,
  onUpdateSettings,
  onSendTestAlert,
  onForceRefresh,
  isRefreshing = false,
  onResetDefaults,
  autoOpenQueueHelp = false,
  onQueueHelpOpened,
  onNavigateToMain
}) => {
  const t = translations[lang];
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [confirmResetOpen, setConfirmResetOpen] = useState(false);
  const [showQueueHelp, setShowQueueHelp] = useState(Boolean(autoOpenQueueHelp));
  const [removeCandidate, setRemoveCandidate] = useState<Subscription | null>(null);
  const [renameCandidate, setRenameCandidate] = useState<Subscription | null>(null);
  const [renameText, setRenameText] = useState('');
  const [verification, setVerification] = useState<{ isChecking: boolean; status: RefreshStatus }>({ isChecking: true, status: 'SUCCESS' });

  useEffect(() => {
    if (autoOpenQueueHelp) {
      setShowQueueHelp(true);
      onQueueHelpOpened?.();
    }
  }, [autoOpenQueueHelp, onQueueHelpOpened]);

  // Live URL verification against valid-urls.json and the real table
  useEffect(() => {
    let isMounted = true;
    setVerification((prev) => ({ ...prev, isChecking: true }));
    const timer = setTimeout(async () => {
      const res = await verifyPoeSite(settings.url);
      if (isMounted) setVerification({ isChecking: false, status: res.status });
    }, 350);
    return () => {
      isMounted = false;
      clearTimeout(timer);
    };
  }, [settings.url, settings.queue]);

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 3000);
  };

  const handleForceRefresh = async () => {
    const status = await onForceRefresh();
    showToast(status === 'NO_INTERNET' ? t.errorNoInternet : status === 'NO_QUEUES_FOUND' ? t.errorNoQueuesFound : t.refreshSuccessToast);
  };

  // Sound and vibration follow the primary address' effective switches, as the single-address fields do
  // Sound and vibration follow the master switch (spec/SUBSCRIPTIONS.md section 7)
  const anyAlertsEnabled = settings.alertsMaster ?? (settings.notificationsEnabled || (settings.emergencyNotificationsEnabled ?? true));

  // Multi-address store (step 2): every change goes through the sync, which mirrors the primary back
  const sync = getSubscriptionSync();
  const store = useMemo(() => sync.store(settings), [sync, settings]);
  const alertsMaster = settings.alertsMaster ?? sync.master(settings);
  const noAddressAlerts = noAlertsCaption(alertsMaster, store);
  const usedQueues = new Set(store.items.filter((i) => i.address === null).map((i) => i.queue));
  const freeQueues = QUEUES.filter((q) => !usedQueues.has(q.id));

  /** Saves the mirrored settings, or says why the store refused the change. */
  const applySync = ({ result, settings: next }: SyncResult): boolean => {
    if (result.ok) {
      onUpdateSettings(next);
      return true;
    }
    if (result.code === ERR_DUPLICATE) showToast(t.addressDuplicate);
    else if (result.code === ERR_LIMIT) showToast(addressLimitReached(lang, MAX_ITEMS));
    return false;
  };
  // Drag the grip to reorder (spec/SUBSCRIPTIONS.md section 4, `move`): a local order follows the pointer,
  // the store is written on release. Arrow keys on the grip move one place.
  const [drag, setDrag] = useState<{ id: string; order: string[]; offset: number } | null>(null);
  const dragLastY = useRef<number | null>(null);
  const itemEls = useRef(new Map<string, HTMLDivElement>());
  const storeIds = store.items.map((i) => i.id);
  const moveTo = (id: string, to: number) => applySync(sync.change(settings, (st) => moveItem(st, id, to)));
  const dragStep = (d: { id: string; order: string[]; offset: number }, dy: number) => {
    let offset = d.offset + dy;
    let order = d.order;
    const i = order.indexOf(d.id);
    const el = itemEls.current.get(d.id);
    const gap = el?.parentElement ? parseFloat(getComputedStyle(el.parentElement).rowGap) || 12 : 12;
    const height = (id: string) => itemEls.current.get(id)?.offsetHeight ?? 0;
    if (offset > 0 && i < order.length - 1) {
      const step = height(order[i + 1]) + gap;
      if (offset > step / 2) {
        order = [...order];
        order.splice(i + 1, 0, ...order.splice(i, 1));
        offset -= step;
      }
    } else if (offset < 0 && i > 0) {
      const step = height(order[i - 1]) + gap;
      if (-offset > step / 2) {
        order = [...order];
        order.splice(i - 1, 0, ...order.splice(i, 1));
        offset += step;
      }
    }
    return { ...d, order, offset };
  };
  const finishDrag = () => {
    if (!drag) return;
    const to = drag.order.indexOf(drag.id);
    const id = drag.id;
    setDrag(null);
    dragLastY.current = null;
    if (to >= 0 && to !== storeIds.indexOf(id)) moveTo(id, to);
  };
  const shownIds = drag ? drag.order : storeIds;
  const isSiteVerified = !verification.isChecking && verification.status === 'SUCCESS';
  const minShort = t.minShort;

  const presetOptions = (presets: number[], current: number) =>
    (presets.includes(current) ? presets : [...presets, current].sort((a, b) => a - b)).map((m) => (
      <option key={m} value={m} className="bg-[#141A29] text-white">
        {m} {minShort}
      </option>
    ));

  return (
    <div className="mx-auto flex max-w-lg select-none flex-col gap-4">
      {/* Toast with the application icon */}
      {toastMessage && (
        <div
          role="status"
          className="fixed top-14 left-1/2 z-50 flex -translate-x-1/2 items-center gap-2.5 rounded-2xl border border-white/20 bg-[#141A29]/95 px-4 py-2 text-sm text-white shadow-2xl backdrop-blur-2xl"
        >
          <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-[#FF5E3A] text-white">
            <Zap className="h-3.5 w-3.5 fill-current" aria-hidden="true" />
          </div>
          <span className="font-bold">{toastMessage}</span>
        </div>
      )}

      {/* Header */}
      <div className="flex items-center gap-2.5 pt-1">
        <Sliders className="h-6 w-6 text-[#FF5E3A]" aria-hidden="true" />
        <h2 className="text-xl font-extrabold leading-7 tracking-tight text-white">{t.settingsTitle}</h2>
      </div>

      {/* 1. My addresses: up to 5 addresses (or queues), each with its own planned / emergency switches */}
      <GlassCard data-testid="my-addresses-card" padding={18} className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <Overline>{t.myAddressesTitle}</Overline>
            <span className={`text-[13px] font-medium leading-[19px] ${TEXT_SECONDARY}`}>{t.myAddressesDesc}</span>
          </div>
          {store.items.length > 0 && (
            <span data-testid="my-addresses-count" className="shrink-0 rounded-full bg-white/10 px-2.5 py-1 text-xs font-bold text-white/80">
              {addressesCount(lang, store.items.length, MAX_ITEMS)}
            </span>
          )}
          {/* 48 px touch target around the 40 px "?" tile; opens the address lookup */}
          <button
            type="button"
            data-testid="settings-queue-help-btn"
            onClick={() => setShowQueueHelp(true)}
            className="flex h-12 w-12 shrink-0 cursor-pointer items-center justify-center"
            title={t.queueHelpTitle}
            aria-label={t.queueHelpTitle}
          >
            <span className="w-10 h-10 rounded-2xl bg-[#FF5E3A] hover:bg-[#ff4b24] text-white flex items-center justify-center border border-white/25 shadow-lg shadow-[#FF5E3A]/35">
              <HelpCircle className="h-5 w-5 stroke-[2.5]" aria-hidden="true" />
            </span>
          </button>
        </div>

        {!alertsMaster && store.items.length > 0 && (
          <p data-testid="master-off-caption" className="text-[13px] font-medium leading-[19px] text-[#FBBF24]">
            {t.masterOffCaption}
          </p>
        )}
        {shownIds.map((id, index) => {
          const item = store.items.find((i) => i.id === id);
          if (!item) return null;
          const isPrimary = item.id === store.primaryId;
          const isDragging = drag?.id === item.id;
          const label = displayLabel(item);
          const caption = item.address ? (item.address.text.trim() ? item.address.text : null) : t.queueOnlyCaption;
          return (
            <div
              key={item.id}
              ref={(el) => {
                if (el) itemEls.current.set(item.id, el);
                else itemEls.current.delete(item.id);
              }}
              data-testid={`subscription-${item.id}`}
              style={isDragging ? { transform: `translateY(${drag.offset}px) scale(1.02)` } : undefined}
              className={`relative flex flex-col gap-1.5 rounded-2xl border bg-white/[0.08] px-3.5 py-3 ${isPrimary ? 'border-[#FF5E3A]/35' : 'border-white/10'} ${
                isDragging ? 'z-10 bg-[#1b2234] shadow-lg shadow-black/40' : ''
              }`}
            >
              <div className="flex items-center gap-1.5">
                {store.items.length >= 2 && (
                  <button
                    type="button"
                    data-testid={`subscription-drag-${item.id}`}
                    aria-label={`${t.reorderHandle}: ${label}`}
                    title={`${t.reorderHandle} (↑ ↓)`}
                    onPointerDown={(e) => {
                      e.currentTarget.setPointerCapture(e.pointerId);
                      dragLastY.current = e.clientY;
                      setDrag({ id: item.id, order: storeIds, offset: 0 });
                    }}
                    onPointerMove={(e) => {
                      if (dragLastY.current === null) return;
                      const dy = e.clientY - dragLastY.current;
                      dragLastY.current = e.clientY;
                      setDrag((d) => (d && d.id === item.id ? dragStep(d, dy) : d));
                    }}
                    onPointerUp={finishDrag}
                    onPointerCancel={finishDrag}
                    onKeyDown={(e) => {
                      if (e.key === 'ArrowUp' && index > 0) {
                        e.preventDefault();
                        moveTo(item.id, index - 1);
                      } else if (e.key === 'ArrowDown' && index < store.items.length - 1) {
                        e.preventDefault();
                        moveTo(item.id, index + 1);
                      }
                    }}
                    className="-ml-2 flex h-12 w-10 shrink-0 cursor-grab touch-none items-center justify-center text-[#BAE6FD]/70 active:cursor-grabbing"
                  >
                    <GripVertical className="h-5 w-5" aria-hidden="true" />
                  </button>
                )}
                <div className="flex min-w-0 flex-1 flex-wrap gap-1.5">
                  {/* a queue-only item already says "Черга X" in its label */}
                  {item.address !== null && (
                    <span className="rounded-full bg-white/10 px-2.5 py-1 text-xs font-bold text-white/80">
                      {item.queue !== null ? `${t.queue} ${item.queue}` : item.queueStatusText ? t.noQueueNotDisconnected : t.selectQueueAction}
                    </span>
                  )}
                  {isPrimary && (
                    <span className="flex items-center gap-1 rounded-full bg-white/10 px-2.5 py-1 text-xs font-bold text-white">
                      <Star className="h-3.5 w-3.5 fill-current" aria-hidden="true" />
                      {t.primaryBadge}
                    </span>
                  )}
                </div>
                <button
                  type="button"
                  aria-label={`${t.renameAddress}: ${label}`}
                  data-tour={index === 0 ? 'rename' : undefined}
                  onClick={() => {
                    setRenameText(item.label);
                    setRenameCandidate(item);
                  }}
                  className="flex h-12 w-12 shrink-0 cursor-pointer items-center justify-center"
                >
                  <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-white/10 text-white">
                    <Pencil className="h-4 w-4" aria-hidden="true" />
                  </span>
                </button>
                <button
                  type="button"
                  aria-label={`${t.removeAddress}: ${label}`}
                  data-testid={`subscription-remove-${item.id}`}
                  onClick={() => setRemoveCandidate(item)}
                  className="flex h-12 w-12 shrink-0 cursor-pointer items-center justify-center"
                >
                  <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-red-500/20 text-red-300">
                    <Trash2 className="h-4 w-4" aria-hidden="true" />
                  </span>
                </button>
              </div>
              <span className="text-base font-bold leading-[23px] text-white">{label}</span>
              {caption && <span className={`text-[13px] font-medium leading-[19px] ${TEXT_SECONDARY}`}>{caption}</span>}
              <SwitchRow
                icon={<Bell className="h-5 w-5 text-white" />}
                title={t.plannedShort}
                hint={plannedDesc(lang, settings.advanceNoticeMinutes)}
                checked={alertsMaster && item.plannedAlerts}
                enabled={alertsMaster && item.queue !== null}
                onToggle={() => applySync(sync.change(settings, (st) => setPlanned(st, item.id, !item.plannedAlerts)))}
                testId={`ios-switch-planned-${item.id}`}
                tour={index === 0 ? 'alert-planned' : undefined}
              />
              <SwitchRow
                icon={<AlertTriangle className="h-5 w-5 text-[#FF5E3A]" />}
                title={t.emergencyShort}
                hint={item.address ? t.emergencyDesc : t.emergencyNeedsAddress}
                checked={alertsMaster && item.emergencyAlerts && item.address !== null}
                enabled={alertsMaster && item.address !== null}
                onToggle={() => applySync(sync.change(settings, (st) => setEmergency(st, item.id, !item.emergencyAlerts)))}
                testId={`ios-switch-emergency-${item.id}`}
                tour={index === 0 ? 'alert-emergency' : undefined}
                titleClassName="break-words leading-snug"
              />
              {!isPrimary && (
                <ActionButton
                  text={t.makePrimary}
                  icon={<Star className="h-4 w-4" aria-hidden="true" />}
                  onClick={() => applySync(sync.change(settings, (st) => setPrimary(st, item.id)))}
                  testId={`subscription-make-primary-${item.id}`}
                />
              )}
            </div>
          );
        })}

        {store.items.length < MAX_ITEMS ? (
          <>
            <ActionButton
              text={t.addAddress}
              icon={<Plus className="h-4 w-4" aria-hidden="true" />}
              filled
              onClick={() => setShowQueueHelp(true)}
              testId="add-address-btn"
            />
            <select
              aria-label={t.addQueueOnly}
              data-testid="settings-queue-select"
              value=""
              onChange={(e) => {
                const q = e.target.value;
                if (!q) return;
                applySync(sync.addQueueOnly(settings, q));
              }}
              className={fieldClass}
            >
              <option value="" className="bg-[#141A29] text-white">
                {t.addQueueOnly}
              </option>
              {freeQueues.map((q) => (
                <option key={q.id} value={q.id} className="bg-[#141A29] text-white">
                  {t.queue} {q.id}
                </option>
              ))}
            </select>
            {store.items.length > 0 && (
              <p className={`text-[13px] font-medium leading-[19px] ${TEXT_TERTIARY}`}>{addressesLeft(lang, MAX_ITEMS - store.items.length)}</p>
            )}
          </>
        ) : (
          <p className={`text-[13px] font-medium leading-[19px] ${TEXT_SECONDARY}`}>{addressLimitReached(lang, MAX_ITEMS)}</p>
        )}
      </GlassCard>

      {/* 2. Site address with a strict check against valid-urls.json and the live table */}
      <GlassCard padding={18} className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
          <Overline className="py-1.5">{t.siteAddressTitle}</Overline>
          {verification.isChecking ? (
            <span className="inline-flex items-center gap-1.5 rounded-xl bg-[#9CA3AF]/20 px-2.5 py-1 text-sm font-semibold leading-5 text-[#9CA3AF]" role="status">
              {t.siteStateChecking}
            </span>
          ) : isSiteVerified ? (
            <span
              data-testid="site-address-reachable"
              className="inline-flex items-center gap-1.5 rounded-xl bg-[#10B981]/20 px-2.5 py-1 text-sm font-semibold leading-5 text-[#34D399]"
            >
              {t.siteReachable}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 rounded-xl bg-[#EF4444]/20 px-2.5 py-1 text-sm font-semibold leading-5 text-[#F87171]" role="alert">
              <AlertCircle className="h-4 w-4" aria-hidden="true" />
              {verification.status === 'NO_INTERNET' ? t.errorNoInternet : t.errorNoQueuesFound}
            </span>
          )}
        </div>
        <p className={`text-[13px] font-medium leading-[19px] ${TEXT_SECONDARY}`}>{t.siteAddressDesc}</p>
        <input
          type="url"
          inputMode="url"
          aria-label={t.siteAddressTitle}
          value={settings.url}
          onChange={(e) => onUpdateSettings({ ...settings, url: e.target.value })}
          placeholder={DEFAULT_POE_URL}
          className={`min-h-14 w-full rounded-2xl border bg-white/[0.08] px-4 py-2 font-mono text-sm text-white focus:outline-none ${
            !verification.isChecking && !isSiteVerified ? 'border-[#EF4444]/40 focus:border-[#EF4444]' : 'border-white/20 focus:border-[#FF5E3A]'
          }`}
        />
      </GlassCard>

      {/* 3. Timers: presets only (no free text), ranges match what really works */}
      <GlassCard padding={18} className="flex flex-col gap-3.5">
        <div className="flex flex-col gap-1.5">
          <div className="flex flex-col gap-0.5">
            <Overline>{t.advanceNoticeTitle}</Overline>
            <span className={`text-[13px] font-medium leading-[19px] ${TEXT_TERTIARY}`}>
              {t.advanceNoticeHint} · {rangeMinutes(lang, ADVANCE_PRESETS[0], ADVANCE_PRESETS[ADVANCE_PRESETS.length - 1])}
            </span>
          </div>
          <select
            aria-label={t.advanceNoticeTitle}
            data-testid="settings-advance-select"
            value={settings.advanceNoticeMinutes}
            onChange={(e) => onUpdateSettings({ ...settings, advanceNoticeMinutes: parseInt(e.target.value, 10) })}
            className={fieldClass}
          >
            {presetOptions(ADVANCE_PRESETS, settings.advanceNoticeMinutes)}
          </select>
        </div>

        <Divider />

        <div className="flex flex-col gap-1.5">
          <div className="flex flex-col gap-0.5">
            <Overline>{t.refreshIntervalTitle}</Overline>
            <span className={`text-[13px] font-medium leading-[19px] ${TEXT_TERTIARY}`}>
              {rangeMinutes(lang, REFRESH_PRESETS[0], REFRESH_PRESETS[REFRESH_PRESETS.length - 1])} · {t.refreshFloorHint}
            </span>
          </div>
          <select
            aria-label={t.refreshIntervalTitle}
            data-testid="settings-refresh-select"
            value={settings.refreshIntervalMinutes}
            onChange={(e) => onUpdateSettings({ ...settings, refreshIntervalMinutes: parseInt(e.target.value, 10) })}
            className={fieldClass}
          >
            {presetOptions(REFRESH_PRESETS, settings.refreshIntervalMinutes)}
          </select>
        </div>
      </GlassCard>

      {/* 4. Alerts: the master switch for all addresses (owner decision 1), then sound and vibration */}
      <GlassCard padding={18} className="flex flex-col gap-2">
        <SwitchRow
          icon={<Bell className="h-5 w-5 text-white" />}
          title={t.notifications}
          hint={t.masterHint}
          checked={alertsMaster}
          onToggle={() => onUpdateSettings(sync.setMaster(settings, !alertsMaster))}
          testId="ios-switch-notifications"
        />
        {noAddressAlerts && (
          <p data-testid="no-address-alerts" className="text-[13px] font-medium leading-[19px] text-[#FF5E3A]">
            {t.noAddressAlerts}
          </p>
        )}
        <Divider />
        <SwitchRow
          icon={<Volume2 className={`h-5 w-5 ${anyAlertsEnabled ? 'text-[#BAE6FD]/70' : 'text-[#BAE6FD]/30'}`} />}
          title={t.sound}
          checked={Boolean(anyAlertsEnabled && settings.soundEnabled)}
          enabled={anyAlertsEnabled}
          onToggle={() => {
            const nextVal = !settings.soundEnabled;
            onUpdateSettings({ ...settings, soundEnabled: nextVal, prevSoundEnabled: nextVal });
          }}
          testId="ios-switch-sound"
        />
        <Divider />
        <SwitchRow
          icon={<Vibrate className={`h-5 w-5 ${anyAlertsEnabled ? 'text-[#BAE6FD]/70' : 'text-[#BAE6FD]/30'}`} />}
          title={t.vibration}
          checked={Boolean(anyAlertsEnabled && settings.vibrationEnabled)}
          enabled={anyAlertsEnabled}
          onToggle={() => {
            const nextVal = !settings.vibrationEnabled;
            onUpdateSettings({ ...settings, vibrationEnabled: nextVal, prevVibrationEnabled: nextVal });
          }}
          testId="ios-switch-vibration"
        />
        <p className={`pt-0.5 text-[13px] font-medium leading-[19px] ${TEXT_TERTIARY}`}>{t.soundVibrationHint}</p>
      </GlassCard>

      {/* 4b. Emergency follow-ups for all addresses (spec/NOTIFICATIONS.md 2.4); the start is always announced */}
      <GlassCard padding={18} className="flex flex-col gap-2" data-testid="emergency-alerts-card">
        <Overline>{t.emergencyAlertsTitle}</Overline>
        <p className={`text-[13px] font-medium leading-[19px] ${TEXT_SECONDARY}`}>{t.emergencyAlertsDesc}</p>
        <SwitchRow
          icon={<Clock className={`h-5 w-5 ${alertsMaster ? 'text-[#FFB020]' : 'text-[#BAE6FD]/30'}`} />}
          title={t.emergencyEtaAlertsTitle}
          hint={t.emergencyEtaAlertsHint}
          checked={alertsMaster && settings.emergencyEtaAlerts !== false}
          enabled={alertsMaster}
          onToggle={() => onUpdateSettings({ ...settings, emergencyEtaAlerts: settings.emergencyEtaAlerts === false })}
          testId="ios-switch-emergency-eta"
        />
        <SwitchRow
          icon={<Zap className={`h-5 w-5 ${alertsMaster ? 'text-[#34D399]' : 'text-[#BAE6FD]/30'}`} />}
          title={t.emergencyEndAlertsTitle}
          hint={t.emergencyEndAlertsHint}
          checked={alertsMaster && settings.emergencyEndAlerts !== false}
          enabled={alertsMaster}
          onToggle={() => onUpdateSettings({ ...settings, emergencyEndAlerts: settings.emergencyEndAlerts === false })}
          testId="ios-switch-emergency-end"
        />
      </GlassCard>


      {/* 5. Language */}
      <GlassCard padding={18} className="flex flex-col gap-2.5">
        <div className="flex items-center gap-2">
          <Globe className="h-[18px] w-[18px] text-[#FF5E3A]" aria-hidden="true" />
          <Overline>{t.languageTitle}</Overline>
        </div>
        <div
          data-testid="ios-segmented-language"
          role="radiogroup"
          aria-label={t.languageTitle}
          className="grid grid-cols-3 items-stretch gap-1 rounded-xl border border-white/10 bg-black/35 p-1"
        >
          {[
            { id: 'system', label: t.langSystem },
            { id: 'uk', label: 'Українська' },
            { id: 'en', label: 'English' }
          ].map((item) => {
            const selected = settings.language === item.id;
            return (
              <button
                key={item.id}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => onUpdateSettings({ ...settings, language: item.id as Language })}
                className={`flex min-h-10 cursor-pointer items-center justify-center break-words rounded-[9px] px-1.5 py-2 text-center text-sm leading-tight transition-colors ${
                  selected ? 'bg-white font-bold text-black shadow-[0_2px_6px_rgba(0,0,0,0.3)]' : 'font-semibold text-sky-100/80 hover:text-white'
                }`}
              >
                {item.label}
              </button>
            );
          })}
        </div>
      </GlassCard>

      {/* 6. Diagnostics and actions */}
      <GlassCard padding={18} className="flex flex-col gap-2.5">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <ActionButton
            text={t.testAlertBtn}
            icon={<Send className="h-4 w-4" aria-hidden="true" />}
            filled
            testId="settings-test-alert"
            onClick={() => {
              onSendTestAlert();
              showToast(t.testAlertSent);
            }}
          />
          <ActionButton
            text={t.refreshBtn}
            icon={<RefreshCw className={`h-4 w-4 ${isRefreshing ? 'animate-spin' : ''}`} aria-hidden="true" />}
            testId="settings-force-refresh"
            onClick={handleForceRefresh}
            busy={isRefreshing}
            busyText={t.refreshing}
          />
        </div>
        <ActionButton
          text={t.resetDefaultsBtn}
          icon={<RotateCcw className="h-4 w-4" aria-hidden="true" />}
          subdued
          testId="settings-reset-defaults"
          onClick={() => setConfirmResetOpen(true)}
        />
      </GlassCard>

      {confirmResetOpen && (
        <ModalPortal>
        <div className="fixed inset-0 z-[65] flex items-center justify-center bg-black/60 p-6" onClick={() => setConfirmResetOpen(false)}>
          <div
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="reset-confirm-title"
            aria-describedby="reset-confirm-desc"
            data-testid="reset-confirm-dialog"
            onClick={(e) => e.stopPropagation()}
            className="flex w-full max-w-sm flex-col gap-3 rounded-3xl border border-white/15 bg-[#141A29] p-6 text-white shadow-2xl"
          >
            <h3 id="reset-confirm-title" className="text-xl font-extrabold leading-7">
              {t.resetConfirmTitle}
            </h3>
            <p id="reset-confirm-desc" className={`text-base font-medium leading-6 ${TEXT_SECONDARY}`}>
              {t.resetConfirmDesc}
            </p>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setConfirmResetOpen(false)}
                className="min-h-12 cursor-pointer rounded-xl px-4 text-sm font-semibold text-white hover:bg-white/10"
              >
                {t.cancel}
              </button>
              <button
                type="button"
                data-testid="reset-confirm-yes"
                onClick={() => {
                  onResetDefaults();
                  setConfirmResetOpen(false);
                  showToast(t.settingsReset);
                }}
                className="min-h-12 cursor-pointer rounded-xl px-4 text-sm font-bold text-[#FF5E3A] hover:bg-white/10"
              >
                {t.resetYes}
              </button>
            </div>
          </div>
        </div>
        </ModalPortal>
      )}

      {showQueueHelp && (
        <ModalPortal>
        <AddressLookupDialog
          settings={settings}
          lang={lang}
          onDismiss={() => setShowQueueHelp(false)}
          onApply={(next, toast) => {
            const wasEmpty = store.items.length === 0;
            const synced = next.selectedAddressQuery
              ? sync.addFromLookup(settings, next.queue, next.customQueueStatusText, next.selectedAddress ?? '', next.selectedAddressQuery)
              : sync.addQueueOnly(settings, next.queue);
            setShowQueueHelp(false);
            // the user stays in Settings (owner request): the address is added in place
            if (applySync(synced)) showToast(wasEmpty ? toast : t.addressAdded);
          }}
          onAddCompany={(queue, label) => {
            setShowQueueHelp(false);
            if (applySync(sync.addQueueOnly(settings, queue, label))) showToast(t.addressAdded);
          }}
        />
        </ModalPortal>
      )}

      {removeCandidate && (
        <ModalPortal>
          <div role="dialog" aria-modal="true" aria-labelledby="remove-address-title" className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
            <div className="flex w-full max-w-sm flex-col gap-3 rounded-3xl border border-white/15 bg-[#141A29] p-5 shadow-2xl">
              <h3 id="remove-address-title" className="text-xl font-extrabold leading-7 text-white">{t.removeConfirmTitle}</h3>
              <p className={`text-[15px] leading-[22px] ${TEXT_SECONDARY}`}>{removeConfirmBody(lang, displayLabel(removeCandidate))}</p>
              <div className="flex gap-2">
                <ActionButton text={t.cancel} onClick={() => setRemoveCandidate(null)} />
                <ActionButton
                  text={t.removeAddress}
                  filled
                  testId="confirm-remove-address"
                  onClick={() => {
                    const id = removeCandidate.id;
                    setRemoveCandidate(null);
                    applySync(sync.change(settings, (st) => removeItem(st, id)));
                  }}
                />
              </div>
            </div>
          </div>
        </ModalPortal>
      )}

      {renameCandidate && (
        <ModalPortal>
          <div role="dialog" aria-modal="true" aria-labelledby="rename-address-title" className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
            <div className="flex w-full max-w-sm flex-col gap-3 rounded-3xl border border-white/15 bg-[#141A29] p-5 shadow-2xl">
              <h3 id="rename-address-title" className="text-xl font-extrabold leading-7 text-white">{t.renameAddress}</h3>
              <input
                type="text"
                value={renameText}
                maxLength={MAX_LABEL_LENGTH}
                placeholder={defaultLabel(renameCandidate)}
                aria-label={t.renameAddress}
                data-testid="rename-address-input"
                onChange={(e) => setRenameText(e.target.value)}
                className="min-h-14 w-full rounded-2xl border border-white/20 bg-white/[0.08] px-4 py-2 text-base font-medium text-white placeholder:text-white/40 focus:border-[#FF5E3A] focus:outline-none"
              />
              <p className={`text-[13px] leading-[19px] ${TEXT_TERTIARY}`}>{t.renameHint}</p>
              <div className="flex gap-2">
                <ActionButton text={t.cancel} onClick={() => setRenameCandidate(null)} />
                <ActionButton
                  text={t.save}
                  filled
                  testId="confirm-rename-address"
                  onClick={() => {
                    const id = renameCandidate.id;
                    setRenameCandidate(null);
                    applySync(sync.change(settings, (st) => renameItem(st, id, renameText)));
                  }}
                />
              </div>
            </div>
          </div>
        </ModalPortal>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------------------------
// Full-screen queue help and address lookup ("?" button)
// =========================================================================================
// CRITICAL SECTION — DO NOT MODIFY THE STEP TEXTS UNLESS EXPLICITLY REQUESTED
// Queue help modal with the numbered instruction for users on how to find their queue
// =========================================================================================

interface AddressLookupDialogProps {
  settings: UserSettings;
  lang: 'uk' | 'en';
  onDismiss: () => void;
  onApply: (next: UserSettings, toast: string) => void;
  /** A workplace from the company search: its queue as a queue-only entry named after the company. */
  onAddCompany: (queue: string, label: string) => void;
}

const AddressLookupDialog: React.FC<AddressLookupDialogProps> = ({ settings, lang, onDismiss, onApply, onAddCompany }) => {
  const t = translations[lang];
  const siteUrl = settings.url;
  const saved = settings.selectedAddressQuery;

  // The cascade starts from the saved address, or from Poltava city (Полтавська об'єднана філія) on a first
  // launch. After that a branch never picks a city for the user: choosing another branch clears city, street and house.
  const [selectedRemId, setSelectedRemId] = useState<string>(saved?.remId || DEFAULT_BRANCH);
  const [selectedSettlementId, setSelectedSettlementId] = useState<string>(saved?.settlementId || DEFAULT_SETTLEMENT);
  const [selectedStreetId, setSelectedStreetId] = useState<string>(saved?.streetId || '');
  const [selectedHouse, setSelectedHouse] = useState<string>(saved?.house || '');

  const [allRems, setAllRems] = useState<PoeBranchOption[]>(() => getRems());
  const [settlementsList, setSettlementsList] = useState<PoeSettlementOption[]>(() => getSettlementsForRem(selectedRemId));
  const [streetsList, setStreetsList] = useState<PoeStreetOption[]>(() => (selectedSettlementId ? getStreetsForSettlement(selectedSettlementId) : []));
  const [housesList, setHousesList] = useState<PoeHouseLookupResult[]>(() => (selectedStreetId ? getHousesForStreet(selectedStreetId) : []));
  const [rems, setRems] = useState<LevelState>(initialLevel);
  const [settlements, setSettlements] = useState<LevelState>(initialLevel);
  const [streets, setStreets] = useState<LevelState>(initialLevel);
  const [houses, setHouses] = useState<LevelState>(initialLevel);

  const [isChecking, setIsChecking] = useState(false);
  const [checkFailed, setCheckFailed] = useState(false);
  const [lookup, setLookup] = useState<PoeHouseLookupResult | null>(null);
  // "My address is missing" (plan section 4.4): which refresh runs and what it reported
  const [refreshing, setRefreshing] = useState<'settlements' | 'streets' | 'directory' | null>(null);
  const [refreshNote, setRefreshNote] = useState<string | null>(null);
  // The queue the user picks when POE names none ("several connections", spec/POE_API.md 8.11)
  const [chosenQueue, setChosenQueue] = useState<string | null>(null);
  // Company search (hourly-schedule catalogue): one entry per company name with all its queues
  const [companies, setCompanies] = useState<CompanyChoice[]>([]);
  const [selectedCompany, setSelectedCompany] = useState<string | null>(null);
  const [companyQueue, setCompanyQueue] = useState<string | null>(null);
  const [catalogueReady, setCatalogueReady] = useState(false);
  // POE answered with no houses for the chosen street (not a failure): the street is taken as a whole
  const [housesAnswered, setHousesAnswered] = useState<string | null>(null);
  // "settlementId|directoryVersion" of the street list on screen: "no streets" only for the list of the chosen one
  const [streetsFor, setStreetsFor] = useState('');
  // The queue picked for a place without streets or house numbers
  const [placeQueue, setPlaceQueue] = useState<string | null>(null);

  const patch = (set: React.Dispatch<React.SetStateAction<LevelState>>, p: Partial<LevelState>) => set((s) => ({ ...s, ...p }));

  const clearBelowSettlement = () => {
    setSelectedStreetId('');
    setSelectedHouse('');
    setHousesList([]);
    setLookup(null);
  };
  const clearBelowRem = () => {
    setSelectedSettlementId('');
    setStreetsList([]);
    clearBelowSettlement();
  };

  // Branch list (spec/branches.json) and the bundled POE address directory (public/poe_directory.json)
  const [directoryVersion, setDirectoryVersion] = useState(0);
  useEffect(() => {
    let cancelled = false;
    patch(setRems, { loading: true, failed: false });
    (async () => {
      await ensurePoeDirectory();
      if (cancelled) return;
      const next = getRems();
      setAllRems(next);
      setDirectoryVersion((v) => v + 1);
      patch(setRems, { loading: false, failed: next.length === 0 });
    })();
    return () => {
      cancelled = true;
    };
  }, [rems.retry]);

  // The hourly-schedule catalogue (about 2 MB), loaded once
  useEffect(() => {
    let cancelled = false;
    (async () => {
      await ensurePoeQueues();
      if (cancelled) return;
      setCompanies(companyChoices());
      setCatalogueReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // City list of the chosen branch. Never selects a city by itself; only drops a choice that no longer exists.
  useEffect(() => {
    const list = getSettlementsForRem(selectedRemId);
    setSettlementsList(list);
    patch(setSettlements, { loading: false, failed: list.length === 0 });
    if (selectedSettlementId && list.length > 0 && !list.some((s) => s.id === selectedSettlementId)) {
      setSelectedSettlementId('');
      clearBelowSettlement();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRemId, settlements.retry, directoryVersion]);

  // Street list of the settlement (bundled POE address directory, spelling variants merged)
  useEffect(() => {
    if (!selectedSettlementId) {
      setStreetsList([]);
      patch(setStreets, { loading: false, failed: false });
      return;
    }
    const list = getStreetsForSettlement(selectedSettlementId);
    setStreetsList(list);
    setStreetsFor(`${selectedSettlementId}|${directoryVersion}`);
    patch(setStreets, { loading: false, failed: list.length === 0 });
  }, [selectedSettlementId, streets.retry, directoryVersion]);

  // House list of the chosen street: live from POE (address search, E3), cached per street
  useEffect(() => {
    if (!selectedStreetId) {
      setHousesList([]);
      patch(setHouses, { loading: false, failed: false });
      setHousesAnswered(null);
      return;
    }
    let cancelled = false;
    setHousesList(getHousesForStreet(selectedStreetId));
    setHousesAnswered(null);
    patch(setHouses, { loading: true, failed: false });
    (async () => {
      let fetched: PoeHouseLookupResult[] | null = null;
      try {
        fetched = await fetchHousesForStreet(selectedRemId, selectedSettlementId, selectedStreetId);
      } catch {
        fetched = null;
      }
      if (cancelled) return;
      const list = fetched !== null && fetched.length > 0 ? fetched : getHousesForStreet(selectedStreetId);
      setHousesList(list);
      // the street id POE answered for, so a list of the previous street never reads as "no houses"
      setHousesAnswered(fetched !== null ? selectedStreetId : null);
      // an answer with no houses is not a failure: the street has no house numbers
      patch(setHouses, { loading: false, failed: fetched === null && list.length === 0 });
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedRemId, selectedSettlementId, selectedStreetId, houses.retry, directoryVersion]);

  const currentRem = allRems.find((r) => r.id === selectedRemId);
  const currentSettlement = selectedSettlementId
    ? settlementsList.find((s) => s.id === selectedSettlementId) ?? findSettlementById(selectedSettlementId)
    : undefined;
  const currentStreet = selectedStreetId ? streetsList.find((s) => s.id === selectedStreetId) ?? findStreetById(selectedStreetId) : undefined;
  const currentHouseRecord = housesList.find((h) => sameHouse(h.house, selectedHouse));

  // Asks POE (per-house status, E4) when street and house are chosen. Nothing closes or applies until the user presses the button.
  useEffect(() => {
    setLookup(null);
    setCheckFailed(false);
    setChosenQueue(null);
    if (!selectedStreetId || !selectedHouse) {
      setIsChecking(false);
      return;
    }
    let cancelled = false;
    setIsChecking(true);
    (async () => {
      let res: PoeHouseLookupResult | null = null;
      try {
        res = await checkAddress({ remId: selectedRemId, settlementId: selectedSettlementId, streetId: selectedStreetId, house: selectedHouse });
      } catch {
        res = null;
      }
      if (cancelled) return;
      setIsChecking(false);
      setLookup(res);
      setCheckFailed(res === null);
      // the catalogue's best queue is pre-selected; the user confirms or picks another
      if (res?.severalConnections) setChosenQueue(res.hints?.[0]?.queue ?? null);
      if (res) {
        setHousesList((prev) => {
          const exists = prev.some((h) => sameHouse(h.house, res!.house));
          if (!exists) return [...prev, res!];
          return prev.map((h) =>
            sameHouse(h.house, res!.house)
              ? { ...h, queue: res!.queue || h.queue, statusText: res!.statusText ?? h.statusText, addressLabel: res!.addressLabel || h.addressLabel }
              : h
          );
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedRemId, selectedSettlementId, selectedStreetId, selectedHouse, directoryVersion]);

  const selectedAddressStr =
    currentStreet && selectedHouse.trim() !== ''
      ? `${currentRem ? displayName(currentRem, lang) : ''}, ${currentSettlement ? placeName(currentSettlement) : ''},\n${placeName(currentStreet)}, ${t.addrHousePrefix} ${selectedHouse}`
      : '';

  const remItems = useMemo<PickerItem[]>(() => allRems.map((r) => ({ id: r.id, label: displayName(r, lang) })), [allRems, lang]);
  // Oblast-wide search (D4): the branch's settlements first, then every other one with its branch named
  const settlementChoices = useMemo(() => settlementChoicesOf(selectedRemId, lang), [settlementsList, selectedRemId, lang, directoryVersion]);
  const settlementItems = useMemo<PickerItem[]>(() => settlementChoices.map((c) => ({ id: c.option.id, label: c.label })), [settlementChoices]);

  const runRefresh = async (kind: 'settlements' | 'streets' | 'directory', work: () => Promise<boolean | null>, okText: (v: boolean) => string) => {
    if (refreshing !== null) return;
    setRefreshing(kind);
    setRefreshNote(null);
    let ok: boolean | null = null;
    try {
      ok = await work();
    } catch {
      ok = null;
    }
    setRefreshing(null);
    if (ok !== null) setDirectoryVersion((v) => v + 1);
    setRefreshNote(ok === null ? t.refreshListFailed : okText(ok));
  };
  const streetItems = useMemo<PickerItem[]>(() => streetsList.map((s) => ({ id: s.id, label: placeName(s) })), [streetsList, lang]);
  const houseItems = useMemo<PickerItem[]>(() => housesList.map((h) => ({ id: h.house, label: h.house })), [housesList]);
  const companyItems = useMemo<PickerItem[]>(
    () => companies.map((c) => ({ id: c.id, label: [c.name, c.town, c.queues.join(', ')].filter(Boolean).join(' · '), search: c.search, context: c.context })),
    [companies]
  );
  const currentCompany = companies.find((c) => c.id === selectedCompany) ?? null;

  // A settlement whose directory has no streets, or a street POE lists no houses for (spec/POE_API.md 8.11):
  // the lower picker is disabled and the place is added as a queue-only entry named after it
  // only once the directory is loaded (an empty list before that means nothing)
  const noStreets =
    selectedSettlementId !== '' &&
    !rems.loading &&
    !rems.failed &&
    !streets.loading &&
    streetsFor === `${selectedSettlementId}|${directoryVersion}` &&
    streetsList.length === 0;
  const noHouses = Boolean(currentStreet) && !houses.loading && housesAnswered === selectedStreetId && housesList.length === 0;
  const placeMode: 'settlement' | 'street' | null = noStreets ? 'settlement' : noHouses ? 'street' : null;
  const placeHints = useMemo(
    () =>
      placeMode === null
        ? []
        : queuesFor({
            remId: selectedRemId,
            settlementId: selectedSettlementId,
            streetId: placeMode === 'street' ? selectedStreetId : '',
            house: '',
          }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [placeMode, selectedRemId, selectedSettlementId, selectedStreetId, catalogueReady, directoryVersion]
  );
  const placeLabel = [currentSettlement ? placeName(currentSettlement) : '', placeMode === 'street' && currentStreet ? placeName(currentStreet) : '']
    .filter((x) => x !== '')
    .join(', ');
  useEffect(() => {
    setPlaceQueue(placeHints[0]?.queue ?? null);
  }, [placeHints]);

  // Result card (shown when a house is selected)
  const validLookup = lookup && sameHouse(lookup.house, selectedHouse) ? lookup : null;
  const matched: PoeHouseLookupResult | null = validLookup && currentHouseRecord
    ? { ...validLookup, queue: validLookup.queue || currentHouseRecord.queue, statusText: validLookup.statusText ?? currentHouseRecord.statusText }
    : validLookup ?? currentHouseRecord ?? (selectedHouse.trim() !== '' ? { house: selectedHouse, queue: '', addressLabel: selectedAddressStr } : null);
  const several = Boolean(matched?.severalConnections) && !matched?.queue;
  const hints = matched?.hints ?? [];
  // while the site answers, an address without a known queue cannot be confirmed yet
  const canApply = matched ? !(isChecking && !matched.queue) && (!several || chosenQueue !== null) : false;
  const applyQueue = several ? chosenQueue ?? '' : matched?.queue ?? '';

  const apply = () => {
    if (!matched) return;
    const query = { remId: selectedRemId, settlementId: selectedSettlementId, streetId: selectedStreetId, house: selectedHouse };
    const addressToSave = selectedAddressStr || matched.addressLabel;
    const hasQueue = applyQueue !== '';
    onApply(
      {
        ...settings,
        queue: hasQueue ? applyQueue : '',
        customQueueStatusText: hasQueue ? undefined : matched.statusText ?? undefined,
        selectedAddress: addressToSave,
        selectedAddressQuery: query,
        activeEmergencyOutage: null
      },
      hasQueue ? `${t.queue} ${applyQueue}` : matched.statusText || t.addrSaved
    );
  };

  const stepClass = 'flex items-start gap-3.5 rounded-2xl border-2 border-white/15 bg-white/[0.04] p-4';
  const numClass = 'mt-0.5 flex h-6 min-w-6 shrink-0 items-center justify-center rounded-full bg-white/15 px-1.5 font-mono text-[13px] font-bold text-white';
  const linkClass = 'inline-flex items-center gap-1 break-all font-semibold text-[#FF5E3A] underline hover:opacity-80';

  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex h-full w-full flex-col bg-[#141A29]" onClick={onDismiss}>
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={t.queueHelpTitle}
        data-testid="settings-queue-help-modal"
        className="relative flex h-full w-full flex-1 flex-col gap-5 overflow-y-auto px-3.5 pt-14 pb-10 text-white focus:outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Modal header */}
        <div className="flex items-center justify-between gap-3 border-b border-white/20 px-1 pb-3.5">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <div
              aria-hidden="true"
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[#FF5E3A] text-xl font-black text-white shadow-md shadow-[#FF5E3A]/30"
            >
              ?
            </div>
            <h3 className="text-xl font-extrabold leading-7 tracking-tight text-white">{t.queueHelpTitle}</h3>
          </div>
          <button
            type="button"
            onClick={onDismiss}
            aria-label={t.pickerClose}
            data-testid="settings-queue-help-close"
            className="flex h-12 w-12 shrink-0 cursor-pointer items-center justify-center"
          >
            <span className="flex h-10 w-10 items-center justify-center rounded-full border border-white/15 bg-white/10 text-white/90 hover:bg-white/20">
              <X className="h-5 w-5" aria-hidden="true" />
            </span>
          </button>
        </div>

        {/* 1) Interactive search by address */}
        <div
          data-testid="ztoe-address-lookup-section"
          className="flex w-full flex-col gap-3.5 rounded-3xl border-2 border-white/25 bg-white/[0.05] p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.15)]"
        >
          <div className="flex flex-col gap-1">
            <div className="text-sm font-extrabold uppercase leading-5 tracking-wider text-white">{t.addrFindTitle}</div>
            <div data-testid="ztoe-address-lookup-subtitle" className="text-[13px] font-medium leading-[19px] text-[#BAE6FD]/80">
              {t.queueHelpAddressSubtitle}
            </div>
          </div>

          <SearchablePickerField
            testId="ztoe-select-rem"
            label={t.addrRemLabel}
            value={currentRem ? displayName(currentRem, lang) : null}
            placeholder={t.addrRemPlaceholder}
            items={remItems}
            selectedId={selectedRemId}
            lang={lang}
            loading={rems.loading}
            loadFailed={rems.failed}
            onRetry={() => patch(setRems, { retry: rems.retry + 1 })}
            onSelect={(item) => {
              if (item.id !== selectedRemId) {
                setSelectedRemId(item.id);
                clearBelowRem();
              }
            }}
          />

          <SearchablePickerField
            testId="ztoe-select-settlement"
            label={t.addrCityLabel}
            value={currentSettlement ? placeName(currentSettlement) : null}
            placeholder={t.addrCityPlaceholder}
            items={settlementItems}
            selectedId={selectedSettlementId || null}
            lang={lang}
            loading={settlements.loading}
            loadFailed={settlements.failed}
            onRetry={() => patch(setSettlements, { retry: settlements.retry + 1 })}
            onSelect={(item) => {
              if (item.id !== selectedSettlementId) {
                // A settlement of another branch fills the branch in (most users do not know their дільниця)
                const choice = settlementChoices.find((c) => c.option.id === item.id);
                const branch = choice?.option.branchIds[0];
                if (choice && !choice.inBranch && branch) setSelectedRemId(branch);
                setSelectedSettlementId(item.id);
                clearBelowSettlement();
              }
            }}
          />
          <div data-testid="settlement-any-branch-hint" className="-mt-2 px-1 text-[13px] font-medium leading-[19px] text-[#BAE6FD]/60">
            {t.addrCityAnyBranchHint}
          </div>

          <SearchablePickerField
            testId="ztoe-select-street"
            label={t.addrStreetLabel}
            value={currentStreet ? placeName(currentStreet) : null}
            placeholder={t.addrStreetPlaceholder}
            items={streetItems}
            selectedId={selectedStreetId || null}
            lang={lang}
            enabled={selectedSettlementId !== '' && !noStreets}
            disabledHint={noStreets ? t.noStreetsHint : t.pickerChooseFirst}
            loading={streets.loading}
            loadFailed={streets.failed && selectedSettlementId !== '' && !noStreets}
            onRetry={() => patch(setStreets, { retry: streets.retry + 1 })}
            onSelect={(item) => {
              if (item.id !== selectedStreetId) {
                setSelectedStreetId(item.id);
                setSelectedHouse('');
                setHousesList(getHousesForStreet(item.id));
                setLookup(null);
              }
            }}
          />

          <SearchablePickerField
            testId="ztoe-select-house"
            label={t.addrHouseLabel}
            value={selectedHouse}
            placeholder={t.addrHousePlaceholder}
            items={houseItems}
            selectedId={selectedHouse || null}
            lang={lang}
            enabled={Boolean(currentStreet) && !noHouses && !noStreets}
            disabledHint={noHouses ? t.noHousesHint : t.pickerChooseFirst}
            loading={houses.loading}
            loadFailed={houses.failed && Boolean(currentStreet)}
            onRetry={() => patch(setHouses, { retry: houses.retry + 1 })}
            kind="HOUSE"
            onSelect={(item) => {
              setSelectedHouse(item.id);
              setLookup(null);
            }}
          />

          {placeMode !== null && (
            <div
              data-testid="place-queue-result"
              className="mt-1.5 flex flex-col gap-2.5 rounded-2xl border-2 border-white/25 bg-[#141A29]/85 p-4 shadow-[0_12px_40px_rgba(0,0,0,0.45)] backdrop-blur-2xl"
            >
              <div className="text-sm font-semibold leading-5 text-[#BAE6FD]/90">{placeLabel}</div>
              <div className="text-sm font-bold leading-5 text-white">{placeMode === 'settlement' ? t.noStreetsHint : t.noHousesHint}</div>
              <div className={`text-[13px] font-medium leading-[19px] ${TEXT_SECONDARY}`}>
                {placeHints.length > 0 ? t.catalogueHintsTitle : t.chooseQueueTitle}
              </div>
              <QueueChoiceChips
                testId="place-queue"
                label={placeHints.length > 0 ? t.catalogueHintsTitle : t.chooseQueueTitle}
                choices={
                  placeHints.length > 0 ? placeHints.map((h) => [h.queue, hintCaption(lang, h.kind)] as const) : QUEUES.map((q) => [q.id, null] as const)
                }
                selected={placeQueue}
                lang={lang}
                onSelect={setPlaceQueue}
              />
              {placeHints.length > 0 && (
                <>
                  <div className={`text-[13px] font-medium leading-[19px] ${TEXT_TERTIARY}`}>{t.chooseQueueTitle}</div>
                  <QueueChoiceChips
                    testId="place-other-queue"
                    label={t.chooseQueueTitle}
                    choices={QUEUES.filter((q) => !placeHints.some((h) => h.queue === q.id)).map((q) => [q.id, null] as const)}
                    selected={placeQueue}
                    lang={lang}
                    onSelect={setPlaceQueue}
                  />
                </>
              )}
              <div className={`text-[13px] font-medium leading-[19px] ${TEXT_TERTIARY}`}>{t.placeQueueHint}</div>
              <ActionButton
                text={placeQueue !== null ? addCompanyQueue(lang, placeQueue) : t.chooseQueueTitle}
                filled={placeQueue !== null}
                testId="place-add"
                onClick={() => {
                  if (placeQueue !== null) onAddCompany(placeQueue, placeLabel);
                }}
              />
            </div>
          )}

          {selectedHouse.trim() !== '' && matched && (
            <div
              data-testid="ztoe-lookup-result"
              className="mt-1.5 flex flex-col gap-2.5 rounded-2xl border-2 border-white/25 bg-[#141A29]/85 p-4 shadow-[0_12px_40px_rgba(0,0,0,0.45)] backdrop-blur-2xl"
            >
              {selectedAddressStr && (
                <div data-testid="ztoe-lookup-selected-address" className="whitespace-pre-line text-sm font-semibold leading-5 text-[#BAE6FD]/90">
                  {selectedAddressStr}
                </div>
              )}

              {isChecking ? (
                <div className="flex items-center gap-2.5" role="status" data-testid="ztoe-lookup-checking">
                  <Loader2 className="h-5 w-5 shrink-0 animate-spin text-[#FF5E3A]" aria-hidden="true" />
                  <span className={`flex-1 text-[13px] font-medium leading-[19px] ${TEXT_SECONDARY}`}>{t.addrChecking}</span>
                </div>
              ) : checkFailed ? (
                <div className="flex items-center gap-2.5" role="alert" data-testid="ztoe-lookup-check-failed">
                  <AlertCircle className="h-5 w-5 shrink-0 text-[#FBBF24]" aria-hidden="true" />
                  <span className="flex-1 text-[13px] font-medium leading-[19px] text-[#FBBF24]">{t.addrCheckFailed}</span>
                </div>
              ) : null}

              {matched.queue && (
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm font-semibold leading-5 text-[#BAE6FD]/80">{t.foundQueue}</span>
                  <span className="whitespace-nowrap font-mono text-base font-extrabold leading-[22px] text-white">
                    {t.queue} {matched.queue}
                  </span>
                </div>
              )}

              {matched.statusText && (
                <div
                  data-testid="ztoe-lookup-status-text"
                  className="whitespace-normal break-words rounded-2xl border-2 border-white/20 bg-white/[0.06] px-4 py-3 text-sm font-bold leading-5 text-white"
                >
                  {matched.statusText}
                </div>
              )}

              {/* Several connections: POE names no queue; the catalogue's queues, or all twelve, to choose from */}
              {several && !isChecking && (
                <div data-testid="several-connections" className="flex flex-col gap-2">
                  <div className="text-sm font-bold leading-5 text-white">{t.severalConnections}</div>
                  <div className={`text-[13px] font-medium leading-[19px] ${TEXT_SECONDARY}`}>
                    {hints.length > 0 ? t.catalogueHintsTitle : t.chooseQueueTitle}
                  </div>
                  <QueueChoiceChips
                    testId="catalogue-queue"
                    label={hints.length > 0 ? t.catalogueHintsTitle : t.chooseQueueTitle}
                    choices={hints.length > 0 ? hints.map((h) => [h.queue, hintCaption(lang, h.kind)] as const) : QUEUES.map((q) => [q.id, null] as const)}
                    selected={chosenQueue}
                    lang={lang}
                    onSelect={setChosenQueue}
                  />
                  {hints.length > 0 && (
                    <>
                      <div className={`text-[13px] font-medium leading-[19px] ${TEXT_TERTIARY}`}>{t.chooseQueueTitle}</div>
                      <QueueChoiceChips
                        testId="other-queue"
                        label={t.chooseQueueTitle}
                        choices={QUEUES.filter((q) => !hints.some((h) => h.queue === q.id)).map((q) => [q.id, null] as const)}
                        selected={chosenQueue}
                        lang={lang}
                        onSelect={setChosenQueue}
                      />
                    </>
                  )}
                </div>
              )}

              <button
                type="button"
                data-testid="ztoe-lookup-confirm-btn"
                disabled={!canApply}
                onClick={apply}
                className={`min-h-12 w-full rounded-2xl px-4 py-3 text-base font-extrabold text-white transition-colors ${
                  canApply ? 'cursor-pointer bg-[#FF5E3A] shadow-lg shadow-[#FF5E3A]/30 hover:bg-[#ff4b24]' : 'cursor-not-allowed bg-[#FF5E3A]/40'
                }`}
              >
                {applyQueue ? `${t.applyQueue} ${applyQueue}` : t.addrConfirm}
              </button>
            </div>
          )}
        </div>

        {/* 1a) Search by workplace: companies named in POE's hourly-schedule PDF (spec/POE_API.md 8.11) */}
        {companies.length > 0 && (
          <div
            data-testid="company-search-section"
            className="flex w-full flex-col gap-3 rounded-3xl border-2 border-white/25 bg-white/[0.05] p-5"
          >
            <div className="text-sm font-extrabold uppercase leading-5 tracking-wider text-white">{t.companyTitle}</div>
            <SearchablePickerField
              testId="company-select"
              label={t.companyLabel}
              value={currentCompany?.name ?? null}
              placeholder={t.companyPlaceholder}
              items={companyItems}
              selectedId={selectedCompany}
              lang={lang}
              contextLabel={t.companyRowMatch}
              onSelect={(item) => {
                setSelectedCompany(item.id);
                const c = companies.find((x) => x.id === item.id);
                setCompanyQueue(c && c.queues.length === 1 ? c.queues[0] : null);
              }}
            />
            <div className={`text-[13px] font-medium leading-[19px] ${TEXT_TERTIARY}`}>{t.companyHint}</div>
            {currentCompany && (
              <>
                {currentCompany.queues.length > 1 && (
                  <QueueChoiceChips
                    testId="company-queue"
                    label={t.chooseQueueTitle}
                    choices={currentCompany.queues.map((q) => [q, null] as const)}
                    selected={companyQueue}
                    lang={lang}
                    onSelect={setCompanyQueue}
                  />
                )}
                <ActionButton
                  text={companyQueue !== null ? addCompanyQueue(lang, companyQueue) : t.chooseQueueTitle}
                  filled={companyQueue !== null}
                  testId="company-add"
                  onClick={() => {
                    if (companyQueue !== null) onAddCompany(companyQueue, currentCompany.label);
                  }}
                />
              </>
            )}
          </div>
        )}

        {/* 2) Manual search heading ("Пошук вручну" / "Manual search") */}
        {/* 1b) "Немає вашої адреси?": scoped refresh, never a crawl of POE from the browser (plan section 4.4) */}
        <div data-testid="address-missing-section" className="flex flex-col gap-2 px-1">
          <div className="text-sm font-bold leading-5 text-white">{t.addrMissingTitle}</div>
          {(
            [
              ['settlements', t.refreshSettlements, () => refreshSettlements(selectedRemId).then((ok) => (ok ? true : null))],
              ...(selectedSettlementId
                ? [['streets', t.refreshStreets, () => refreshStreets(selectedRemId, selectedSettlementId).then((ok) => (ok ? true : null))]]
                : []),
              [
                'directory',
                t.refreshDirectory,
                () => updateDirectory().then((r) => (r === 'UPDATED' ? true : r === 'UP_TO_DATE' ? false : null)),
              ],
            ] as ['settlements' | 'streets' | 'directory', string, () => Promise<boolean | null>][]
          ).map(([kind, label, work]) => (
            <button
              key={kind}
              type="button"
              data-testid={`refresh-${kind}`}
              disabled={refreshing !== null}
              aria-busy={refreshing === kind}
              onClick={() =>
                runRefresh(kind, work, (v) => (kind === 'directory' ? (v ? t.directoryUpdated : t.directoryUpToDate) : t.refreshListDone))
              }
              className="flex min-h-12 w-full items-center justify-center gap-2 rounded-2xl border border-white/10 px-3 py-2.5 text-sm font-semibold leading-5 text-[#BAE6FD]/80 hover:bg-white/5 disabled:opacity-60"
            >
              <RefreshCw className={`h-4 w-4 ${refreshing === kind ? 'animate-spin motion-reduce:animate-none' : ''}`} aria-hidden="true" />
              {label}
            </button>
          ))}
          {refreshNote !== null && (
            <div role="status" data-testid="refresh-note" className="text-[13px] font-medium leading-[19px] text-[#BAE6FD]/80">
              {refreshNote}
            </div>
          )}
        </div>

        <div data-testid="queue-help-manual-search-title" className="px-1 pt-1 text-sm font-extrabold uppercase leading-5 tracking-wider text-white">
          {t.queueHelpManualSearchTitle}
        </div>

        {/* 3) Numbered instruction steps (1..4): the approved POE text (owner, 2026-11-16), as AppStrings.queueHelpSteps */}
        <div className="flex flex-col gap-3 text-base leading-6 text-zinc-100">
          {queueHelpSteps(lang).map((step, i) => {
            const at = step.indexOf(QUEUE_HELP_URL);
            return (
              <div key={i} className={stepClass}>
                <span className={numClass}>{i + 1}</span>
                <div className="flex-1">
                  {at < 0 ? (
                    <span>{step}</span>
                  ) : (
                    <span>
                      {step.slice(0, at)}
                      <a href={QUEUE_HELP_URL} target="_blank" rel="noopener noreferrer" className={linkClass}>
                        {QUEUE_HELP_URL} <ExternalLink className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                      </a>
                      {step.slice(at + QUEUE_HELP_URL.length)}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* Got it action button */}
        <button
          type="button"
          data-testid="settings-queue-help-got-it"
          onClick={onDismiss}
          className="mt-1 min-h-12 w-full cursor-pointer rounded-2xl bg-white px-5 py-3 text-center text-base font-extrabold text-black shadow-lg transition-colors hover:bg-zinc-200"
        >
          {lang === 'uk' ? 'Зрозуміло' : 'Got it'}
        </button>
      </div>
    </div>
  );
};
