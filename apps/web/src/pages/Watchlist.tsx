import {
  PrescreenSettings,
  WatchlistCompanies,
  WatchlistHeader,
  WatchlistRules,
  WatchlistSearches,
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
      <WatchlistCompanies />
      <WatchlistSearches />
      <WatchlistRules status={status} />
      <PrescreenSettings />
    </div>
  );
}
