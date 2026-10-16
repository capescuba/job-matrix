import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { api } from './api.ts';
import { AiActivity } from './components/AiActivity.tsx';
import { ThemeToggle } from './components/ThemeToggle.tsx';
import { runSearchesInChrome } from './extension.ts';
import { cx } from './components/ui.tsx';
import ApplicationDetailPage from './pages/ApplicationDetail.tsx';
import ApplicationsPage from './pages/Applications.tsx';
import DashboardPage from './pages/Dashboard.tsx';
import EmailUpdatesPage from './pages/EmailUpdates.tsx';
import InterviewCoachPage from './pages/InterviewCoach.tsx';
import LogsPage from './pages/Logs.tsx';
import ProfilePage from './pages/Profile.tsx';
import ScreeningPage from './pages/Screening.tsx';
import UsagePage from './pages/Usage.tsx';
import WatchlistPage from './pages/Watchlist.tsx';

/** The pages you work in day to day. */
const nav = [
  { to: '/dashboard', label: 'Dashboard' },
  { to: '/screening', label: 'Screening' },
  { to: '/watchlist', label: 'Watchlist' },
  { to: '/applications', label: 'Applications' },
  { to: '/email', label: 'Email' },
];
/** Set-up and housekeeping, tucked behind one menu on the right. */
const more = [
  { to: '/profile', label: 'Profile' },
  { to: '/usage', label: 'AI usage' },
  { to: '/logs', label: 'Log' },
];

const navLink = ({ isActive }: { isActive: boolean }) =>
  cx(
    'rounded-md px-3 py-1.5 text-sm',
    isActive ? 'bg-surface-2 font-medium text-ink' : 'text-ink-2 hover:text-ink',
  );

export default function App() {
  useSearchSchedule();
  return (
    <Routes>
      {/* The live coach is full-window, without the app's header. */}
      <Route path="/interview/:applicationId/:sessionId?" element={<InterviewCoachPage />} />
      <Route path="*" element={<MainShell />} />
    </Routes>
  );
}

function MainShell() {
  const { data: apps = [] } = useQuery({
    queryKey: ['applications'],
    queryFn: api.listApplications,
  });
  const inbox = apps.filter((a) => a.status === 'Screening').length;
  const { data: mail } = useQuery({
    queryKey: ['mail-status'],
    queryFn: api.mailStatus,
    refetchInterval: (q) =>
      q.state.data?.progress.running || q.state.data?.signingIn ? 2000 : 60_000,
  });
  const emailPending = mail?.pending ?? 0;
  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-40 border-b border-border bg-surface/90 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center gap-6 px-4 py-2.5">
          <Link to="/dashboard" className="flex items-center gap-2 font-semibold tracking-tight">
            <img src="/favicon.svg" alt="" className="size-5" />
            Job Matrix
          </Link>
          <nav className="flex gap-1">
            {nav.map((n) => (
              <NavLink key={n.to} to={n.to} className={navLink}>
                {n.label}
                {n.to === '/screening' && inbox > 0 && (
                  <span className="ml-1.5 rounded-full bg-warn/15 px-1.5 text-xs font-semibold text-warn">
                    {inbox}
                  </span>
                )}
                {n.to === '/email' && emailPending > 0 && (
                  <span className="ml-1.5 rounded-full bg-accent/15 px-1.5 text-xs font-semibold text-accent">
                    {emailPending}
                  </span>
                )}
              </NavLink>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <AiActivity />
            <ThemeToggle />
            <MoreMenu />
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-4 py-6">
        <Routes>
          <Route path="/" element={<Navigate to="/dashboard" replace />} />
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/screening" element={<ScreeningPage />} />
          <Route path="/watchlist" element={<WatchlistPage />} />
          <Route path="/applications" element={<ApplicationsPage />} />
          <Route path="/applications/:id" element={<ApplicationDetailPage />} />
          <Route path="/profile" element={<ProfilePage />} />
          <Route path="/usage" element={<UsagePage />} />
          <Route path="/email" element={<EmailUpdatesPage />} />
          <Route path="/logs" element={<LogsPage />} />
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Routes>
      </main>
    </div>
  );
}

/**
 * Saved searches can only run in Chrome, through the extension, so this page starts them when
 * the server says they are due. The extension stamps the run on the server, so other open
 * windows don't start another; a failed attempt waits ten minutes before the next.
 */
function useSearchSchedule() {
  const { data } = useQuery({
    queryKey: ['crawl-due'],
    queryFn: api.crawlStatus,
    refetchInterval: 60_000,
  });
  const lastTry = useRef(0);
  useEffect(() => {
    if (!data?.searchesDue || Date.now() - lastTry.current < 10 * 60_000) return;
    lastTry.current = Date.now();
    void runSearchesInChrome();
  }, [data?.searchesDue]);
}

/** Profile, AI usage and Log: one button on the right that names the page you are on. */
function MoreMenu() {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const { pathname } = useLocation();
  const here = more.find((m) => pathname.startsWith(m.to));
  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('mousedown', away);
    window.addEventListener('keydown', esc);
    return () => {
      window.removeEventListener('mousedown', away);
      window.removeEventListener('keydown', esc);
    };
  }, [open]);
  return (
    <div ref={box} className="relative">
      <button
        className={navLink({ isActive: Boolean(here) })}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {here?.label ?? 'More'} <span className="text-ink-3">▾</span>
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 mt-1 w-40 rounded-md border border-border bg-surface py-1 shadow-lg"
        >
          {more.map((m) => (
            <NavLink
              key={m.to}
              to={m.to}
              role="menuitem"
              className={({ isActive }) =>
                cx(
                  'block px-3 py-1.5 text-sm hover:bg-surface-2',
                  isActive ? 'font-medium text-ink' : 'text-ink-2',
                )
              }
            >
              {m.label}
            </NavLink>
          ))}
        </div>
      )}
    </div>
  );
}
