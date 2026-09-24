import { useQuery } from '@tanstack/react-query';
import { Link, NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { api } from './api.ts';
import { AiActivity } from './components/AiActivity.tsx';
import { ThemeToggle } from './components/ThemeToggle.tsx';
import { cx } from './components/ui.tsx';
import ApplicationDetailPage from './pages/ApplicationDetail.tsx';
import ApplicationsPage from './pages/Applications.tsx';
import DashboardPage from './pages/Dashboard.tsx';
import ProfilePage from './pages/Profile.tsx';
import ScreeningPage from './pages/Screening.tsx';
import UsagePage from './pages/Usage.tsx';

const nav = [
  { to: '/dashboard', label: 'Dashboard' },
  { to: '/screening', label: 'Screening' },
  { to: '/applications', label: 'Applications' },
  { to: '/profile', label: 'Profile' },
  { to: '/usage', label: 'AI usage' },
];

export default function App() {
  const { data: apps = [] } = useQuery({
    queryKey: ['applications'],
    queryFn: api.listApplications,
  });
  const inbox = apps.filter((a) => a.status === 'Screening').length;
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
              <NavLink
                key={n.to}
                to={n.to}
                className={({ isActive }) =>
                  cx(
                    'rounded-md px-3 py-1.5 text-sm',
                    isActive ? 'bg-surface-2 font-medium text-ink' : 'text-ink-2 hover:text-ink',
                  )
                }
              >
                {n.label}
                {n.to === '/screening' && inbox > 0 && (
                  <span className="ml-1.5 rounded-full bg-warn/15 px-1.5 text-xs font-semibold text-warn">
                    {inbox}
                  </span>
                )}
              </NavLink>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <AiActivity />
            <ThemeToggle />
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-4 py-6">
        <Routes>
          <Route path="/" element={<Navigate to="/dashboard" replace />} />
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/screening" element={<ScreeningPage />} />
          <Route path="/applications" element={<ApplicationsPage />} />
          <Route path="/applications/:id" element={<ApplicationDetailPage />} />
          <Route path="/profile" element={<ProfilePage />} />
          <Route path="/usage" element={<UsagePage />} />
          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Routes>
      </main>
    </div>
  );
}
