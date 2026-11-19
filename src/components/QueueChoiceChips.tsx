/**
 * One selectable chip per queue ("Черга 3.1" with an optional caption), for an address whose queue POE does
 * not name ("several connections", spec/POE_API.md 8.11) and for a company with several queues. A radio
 * group for screen readers. Mirrors android/.../ui/components/QueueChoiceChips.kt.
 */
import React from 'react';
import type { CatalogueKind } from '../core/queueCatalogue';
import { translations } from '../services/i18n';

/** "будинок у списку", "уся вулиця" ... for a catalogue hint (mirrors hintCaption). */
export function hintCaption(lang: 'uk' | 'en', kind: CatalogueKind): string {
  const t = translations[lang];
  switch (kind) {
    case 'HOUSE':
      return t.hintHouse;
    case 'RANGE':
      return t.hintRange;
    case 'STREET':
      return t.hintStreet;
    case 'SETTLEMENT':
      return t.hintSettlement;
  }
}

interface QueueChoiceChipsProps {
  choices: readonly (readonly [string, string | null])[];
  selected: string | null;
  lang: 'uk' | 'en';
  onSelect: (queue: string) => void;
  label: string;
  testId?: string;
}

export const QueueChoiceChips: React.FC<QueueChoiceChipsProps> = ({ choices, selected, lang, onSelect, label, testId }) => {
  const t = translations[lang];
  return (
    <div role="radiogroup" aria-label={label} data-testid={testId} className="flex flex-wrap gap-2">
      {choices.map(([queue, caption]) => {
        const on = queue === selected;
        return (
          <button
            key={queue}
            type="button"
            role="radio"
            aria-checked={on}
            data-testid={testId ? `${testId}-${queue}` : undefined}
            onClick={() => onSelect(queue)}
            className={`flex min-h-12 cursor-pointer flex-col items-start justify-center rounded-xl border px-3 py-2 text-left ${
              on ? 'border-white/25 bg-[#FF5E3A]' : 'border-white/15 bg-white/[0.08] hover:bg-white/[0.12]'
            }`}
          >
            <span className="font-mono text-sm font-bold leading-5 text-white">
              {t.queue} {queue}
            </span>
            {caption !== null && (
              <span className={`text-[13px] font-medium leading-[19px] ${on ? 'text-white' : 'text-[#BAE6FD]/80'}`}>{caption}</span>
            )}
          </button>
        );
      })}
    </div>
  );
};
