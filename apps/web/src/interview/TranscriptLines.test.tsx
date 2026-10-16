import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Turn } from './live.ts';
import { TranscriptLines } from './TranscriptLines.tsx';

const turns: Turn[] = [
  { id: 1, speaker: 'them', text: 'Thanks for joining.', startMs: 0, endMs: 1000 },
  { id: 2, speaker: 'me', text: 'Happy to be here.', startMs: 1200, endMs: 2000 },
  { id: 3, speaker: 'them', text: 'Tell me about yourself.', startMs: 2500, endMs: 4000 },
  { id: 4, speaker: 'me', text: 'I run large programs.', startMs: 4500, endMs: 7000 },
];

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

describe('TranscriptLines', () => {
  it('in the pop-out shows only the last three lines, then what is being said now', () => {
    const html = renderToStaticMarkup(
      <TranscriptLines
        live={{ turns, pending: { me: null, them: 'And why did you' } }}
        limit={3}
        compact
      />,
    );
    const t = text(html);
    expect(t).not.toContain('Thanks for joining.');
    expect(t).toContain('You Happy to be here.');
    expect(t).toContain('Them Tell me about yourself.');
    expect(t.endsWith('Them And why did you')).toBe(true);
    expect(html).toContain('text-xs');
  });

  it('says where the transcript will appear before anyone speaks', () => {
    const html = renderToStaticMarkup(
      <TranscriptLines live={{ turns: [], pending: { me: null, them: null } }} limit={8} />,
    );
    expect(text(html)).toBe('Transcript appears here.');
  });
});
