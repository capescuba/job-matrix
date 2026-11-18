/**
 * Reading an email in the app from its Outlook link: the Email page's updates, and the recruiter
 * emails behind Screening cards and job pages.
 */
import { inArray } from 'drizzle-orm';
import { GraphError, type MailClient, type MailReading } from '@jm/mail';
import type { Db } from '../../db/client.ts';
import { emailUpdates, mailLeads } from '../../db/schema.ts';
import { NotFoundError } from '../applications.ts';
import { outlookMessageId, spellings } from './outlookPage.ts';

/**
 * The email an Outlook link names. Outlook gives an email a new id when it moves folders, so a
 * stale id falls back to what Job Matrix saved of it (an email update or a job lead): the email
 * received at the same moment with the same subject. The saved id and link are then updated.
 */
export async function readEmail(db: Db, client: MailClient, link: string): Promise<MailReading> {
  const id = outlookMessageId(link);
  if (!id) throw new NotFoundError('That isn’t a link to an Outlook email.');
  // Outlook's links spell the id with "/" and "+", Graph with "-" and "_": try each.
  const ids = spellings(id);
  for (const s of ids) {
    try {
      return await client.messageForReading(s);
    } catch (e) {
      if (!(e instanceof GraphError) || (e.status !== 404 && e.status !== 400)) throw e;
    }
  }
  const update = db.select().from(emailUpdates).where(inArray(emailUpdates.messageId, ids)).get();
  const lead = db.select().from(mailLeads).where(inArray(mailLeads.messageId, ids)).get();
  const known = update ?? lead;
  if (!known)
    throw new NotFoundError('This email has moved or been deleted in Outlook since it was saved.');
  let found: string | null = null;
  for await (const page of client.messagesSince(known.receivedAt, 25)) {
    const hit = page.find(
      (m) =>
        m.receivedAt === known.receivedAt &&
        m.subject === known.subject &&
        // A lead's Message-ID header never changes: when both have one, it must match.
        (!lead || !m.internetMessageId || m.internetMessageId === lead.internetMessageId),
    );
    found = hit?.id ?? null;
    break; // oldest first from that moment: the first page is enough
  }
  if (!found)
    throw new NotFoundError('This email is no longer in your mailbox (deleted, or moved to Sent).');
  const msg = await client.messageForReading(found);
  const moved = { messageId: msg.id, webLink: msg.webLink };
  db.update(emailUpdates).set(moved).where(inArray(emailUpdates.messageId, ids)).run();
  db.update(mailLeads).set(moved).where(inArray(mailLeads.messageId, ids)).run();
  return msg;
}
