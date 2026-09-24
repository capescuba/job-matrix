import { useEffect, useState } from 'react';
import { cx } from './ui.tsx';

type Theme = 'system' | 'light' | 'dark';
const KEY = 'jm-theme';

function readTheme(): Theme {
  try {
    const t = localStorage.getItem(KEY);
    return t === 'light' || t === 'dark' ? t : 'system';
  } catch {
    return 'system';
  }
}

/** System / Light / Dark. "System" follows Windows; the others pin it. Saved per browser. */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(readTheme);

  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'system') delete root.dataset.theme;
    else root.dataset.theme = theme;
    try {
      if (theme === 'system') localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, theme);
    } catch {
      // Storage unavailable — the choice just won't persist.
    }
  }, [theme]);

  const options: { value: Theme; label: string; icon: string }[] = [
    { value: 'system', label: 'Match Windows', icon: '◐' },
    { value: 'light', label: 'Light', icon: '☀' },
    { value: 'dark', label: 'Dark', icon: '☾' },
  ];
  return (
    <div
      className="flex rounded-md border border-border p-0.5"
      role="radiogroup"
      aria-label="Theme"
    >
      {options.map((o) => (
        <button
          key={o.value}
          role="radio"
          aria-checked={theme === o.value}
          title={o.label}
          onClick={() => setTheme(o.value)}
          className={cx(
            'rounded px-2 py-0.5 text-sm leading-6',
            theme === o.value ? 'bg-surface-2 text-ink' : 'text-ink-3 hover:text-ink',
          )}
        >
          <span aria-hidden>{o.icon}</span>
          <span className="sr-only">{o.label}</span>
        </button>
      ))}
    </div>
  );
}
