import {
  JobSites,
  PrescreenSettings,
  WatchlistCompanies,
  WatchlistHeader,
  WatchlistRules,
  useCrawlStatus,
} from '../components/Watchlist.tsx';

/**
 * The watchlist: the company job boards you follow, your saved searches on job sites, the rules
 * for what is picked up, and the optional pre-screen. What it finds lands in the Screening inbox.
 */
export default function WatchlistPage() {
  const status = useCrawlStatus();
  return (
    <div className="space-y-4">
      <WatchlistHeader status={status} />
      <JobSites />
      <WatchlistCompanies />
      <WatchlistRules status={status} />
      <PrescreenSettings />
    </div>
  );
}
