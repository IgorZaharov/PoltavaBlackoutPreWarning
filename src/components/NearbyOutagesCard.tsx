/**
 * «Ремонти й пошкодження поруч» (docs/POLTAVA_PORT_PLAN.md 5.4, spec/POE_API.md 8.10), mirrored from
 * android/.../ui/components/NearbyOutagesCard.kt: today's registry rows of the address's settlement,
 * above the hero card. Display only; a row expands to its streets and houses. When a branch could not be
 * asked, the time of the shown data is named.
 */
import React, { useState } from 'react';
import { ChevronDown, ChevronUp, Wrench } from 'lucide-react';
import { hourOf, minuteOf, wallMinutesBetween, fromInstant, type LocalDateTime } from '../core/localTime';
import type { NearbyOutage, NearbyStreet } from '../core/poeMapper';
import type { NearbySnapshot } from '../services/outageRepository';
import { durationText, nearbyAt, staleChip, translations } from '../services/i18n';
import { GlassCard } from './GlassCard';
import { TONE_COLORS } from './siteStatus';

type Lang = 'uk' | 'en';
const p2 = (n: number) => String(n).padStart(2, '0');
const hm = (t: LocalDateTime) => `${p2(hourOf(t))}:${p2(minuteOf(t))}`;

/** The texts of one card row (NearbyFormat on Android). */
export const NearbyFormat = {
  timeRange: (o: NearbyOutage): string => `${hm(o.start)} – ${o.end !== null ? hm(o.end) : '--:--'}`,
  status: (lang: Lang, o: NearbyOutage): string =>
    o.status === 'ACTIVE' ? translations[lang].nearbyNow : o.status === 'UPCOMING' ? nearbyAt(lang, hm(o.start)) : translations[lang].rowFinished,
  duration: (lang: Lang, o: NearbyOutage): string | null => (o.end !== null ? durationText(lang, wallMinutesBetween(o.start, o.end)) : null),
  kind: (lang: Lang, o: NearbyOutage): string => (o.kind === 'EMERGENCY' ? translations[lang].nearbyKindEmergency : translations[lang].nearbyKindRepair),
  yours: (lang: Lang, o: NearbyOutage): string | null =>
    o.match === 'CONFIRMED' ? translations[lang].nearbyYourHouse : o.streets.some((s) => s.mine) ? translations[lang].nearbyYourStreet : null,
  houses: (lang: Lang, s: NearbyStreet): string =>
    s.houses.length === 0 ? translations[lang].nearbyWholeStreet : `${translations[lang].addrHousePrefix} ${s.houses.join(', ')}`,
};

const NearbyRow: React.FC<{ o: NearbyOutage; lang: Lang }> = ({ o, lang }) => {
  const [expanded, setExpanded] = useState(false);
  const t = translations[lang];
  const emergency = o.kind === 'EMERGENCY';
  const yours = NearbyFormat.yours(lang, o);
  const chip = emergency ? TONE_COLORS.RED : TONE_COLORS.GREY;
  return (
    <button
      type="button"
      data-testid="nearby-row"
      aria-expanded={expanded}
      aria-label={`${NearbyFormat.kind(lang, o)} ${NearbyFormat.timeRange(o)}. ${expanded ? t.nearbyCollapse : t.nearbyExpand}`}
      onClick={() => setExpanded((v) => !v)}
      className={`flex w-full flex-col gap-1.5 rounded-[14px] bg-white/[0.08] px-3 py-2.5 text-left ${o.status === 'FINISHED' ? 'opacity-55' : ''}`}
    >
      <div className="flex w-full items-center gap-2">
        <span className="rounded-[10px] px-2 py-0.5 text-[13px] font-bold leading-[19px]" style={{ background: chip.fill, color: chip.text }}>
          {NearbyFormat.kind(lang, o)}
        </span>
        <span className="whitespace-nowrap font-mono text-sm font-bold leading-5 text-white">{NearbyFormat.timeRange(o)}</span>
        <span className="flex-1 text-[13px] font-medium leading-[19px] text-[#BAE6FD]/70">
          {[NearbyFormat.status(lang, o), NearbyFormat.duration(lang, o)].filter(Boolean).join(' · ')}
        </span>
        {expanded ? <ChevronUp className="h-5 w-5 text-[#BAE6FD]/70" aria-hidden="true" /> : <ChevronDown className="h-5 w-5 text-[#BAE6FD]/70" aria-hidden="true" />}
      </div>
      {yours !== null && (
        <span className="text-[13px] font-bold leading-[19px]" style={{ color: TONE_COLORS.AMBER.text }}>
          {yours}
        </span>
      )}
      {!expanded ? (
        <span className="line-clamp-2 text-[13px] font-medium leading-[19px] text-[#BAE6FD]/70">{o.streets.map((s) => s.name).join(', ')}</span>
      ) : (
        o.streets.map((s) => (
          <span key={s.name} className="flex flex-col">
            <span className={`text-[13px] leading-[19px] ${s.mine ? 'font-bold' : 'font-medium text-white'}`} style={s.mine ? { color: TONE_COLORS.AMBER.text } : undefined}>
              {s.name}
            </span>
            <span className="text-[13px] font-medium leading-[19px] text-[#BAE6FD]/70">{NearbyFormat.houses(lang, s)}</span>
          </span>
        ))
      )}
    </button>
  );
};

export const NearbyOutagesCard: React.FC<{ nearby: NearbySnapshot; lang: Lang }> = ({ nearby, lang }) => {
  const t = translations[lang];
  return (
    <GlassCard data-testid="nearby-outages-card" padding={14} className="flex flex-col gap-2.5">
      <div className="flex items-center gap-2.5">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full" style={{ background: TONE_COLORS.AMBER.fill }}>
          <Wrench className="h-4 w-4" style={{ color: TONE_COLORS.AMBER.text }} aria-hidden="true" />
        </span>
        <span className="flex-1 text-sm font-bold leading-5 text-white">{t.nearbyTitle}</span>
        {!nearby.complete && (
          <span className="font-mono text-[13px] font-bold leading-[19px]" style={{ color: TONE_COLORS.AMBER.text }}>
            {staleChip(lang, hm(fromInstant(nearby.fetchedMs)))}
          </span>
        )}
      </div>
      {nearby.items.map((o) => (
        <NearbyRow key={`${o.id}_${o.start}`} o={o} lang={lang} />
      ))}
      <span className="text-[13px] font-medium leading-[19px] text-[#BAE6FD]/60">{t.nearbyHint}</span>
    </GlassCard>
  );
};
