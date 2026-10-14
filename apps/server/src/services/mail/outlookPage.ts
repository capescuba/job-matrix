/**
 * An email open in Outlook on the web, for the side panel: which email it is (from the tab's
 * address), the Screening job it became if it did, and what a new job from it would be called.
 */
import { eq, inArray } from 'drizzle-orm';
import { GraphError, NeedsSignIn, type MailClient, type MailMessage } from '@jm/mail';
import type { Db } from '../../db/client.ts';
import { mailLeads } from '../../db/schema.ts';
import { addLead, leadBody, leadFields } from './leads.ts';

const OUTLOOK_HOST = /^outlook\.(live|office|office365)\.com$|^outlook\.cloud\.microsoft$/i;

/**
 * The id in an Outlook on the web address: the reading pane's …/mail/0/<folder>/id/<id> (a
 * conversation's id, or a message's with conversations turned off), a deep link's
 * …/deeplink/read/<id> or ?ItemID=<id>. Null for the mailbox itself, the calendar, other sites.
 */
export function outlookMessageId(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (!OUTLOOK_HOST.test(u.hostname)) return null;
  const item = u.searchParams.get('ItemID');
  if (item) return item;
  if (!/\/mail\//i.test(u.pathname)) return null;
  const m = /\/(?:id|deeplink\/read)\/([^/?#]+)/.exec(u.pathname);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]!);
  } catch {
    return m[1]!;
  }
}

/**
 * The same id as Graph spells it (URL-safe base64: "-" and "_") first, then as Outlook's
 * deep links do ("/" and "+").
 */
const spellings = (id: string) => [
  ...new Set([
    id.replace(/\//g, '-').replace(/\+/g, '_'),
    id,
    id.replace(/-/g, '/').replace(/_/g, '+'),
  ]),
];

export interface EmailContext {
  /** The email's Graph id (for "Add to Screening"); the address's id when it couldn't be read. */
  messageId: string;
  subject: string | null;
  from: string | null;
  receivedAt: string | null;
  /** The Screening job this email became (null: not added yet). */
  applicationId: number | null;
  /** What a job from it would be: from the email's lines and subject (no AI). */
  detected: { title: string | null; company: string | null; postingUrl: string | null };
  /** Why the email itself couldn't be read (not connected, not found). */
  error: string | null;
}

const notThere = (e: unknown) => e instanceof GraphError && (e.status === 404 || e.status === 400);

/**
 * The email an address names: the message itself, else the conversation's — the email from the
 * job-leads table if one is in it, else the newest one you didn't send.
 */
async function readOpenEmail(db: Db, client: MailClient, id: string): Promise<MailMessage | null> {
  for (const s of spellings(id)) {
    try {
      return await client.message(s);
    } catch (e) {
      if (!notThere(e)) throw e;
    }
  }
  for (const s of spellings(id)) {
    let thread: Awaited<ReturnType<MailClient['messagesInConversation']>>;
    try {
      thread = await client.messagesInConversation(s);
    } catch (e) {
      if (notThere(e)) continue;
      throw e;
    }
    if (!thread.length) continue;
    const keys = thread.map((m) => m.internetMessageId).filter((k): k is string => !!k);
    const known = keys.length
      ? db
          .select({ key: mailLeads.internetMessageId })
          .from(mailLeads)
          .where(inArray(mailLeads.internetMessageId, keys))
          .get()
      : undefined;
    const me = (await client.status()).account?.toLowerCase() ?? null;
    const pick =
      thread.find((m) => known && m.internetMessageId === known.key) ??
      thread.find((m) => m.from.address && m.from.address !== me) ??
      thread[0]!;
    return client.message(pick.id);
  }
  return null;
}

/** Reads the open email (Graph), keeping the stored Outlook link current if it moved. */
export async function emailContext(
  db: Db,
  client: MailClient | undefined,
  urlId: string,
): Promise<EmailContext> {
  const ids = spellings(urlId);
  // Known without asking Outlook: by the message's id, or its conversation's.
  const stored =
    db.select().from(mailLeads).where(inArray(mailLeads.messageId, ids)).get() ??
    db.select().from(mailLeads).where(inArray(mailLeads.conversationId, ids)).get();
  let msg: MailMessage | null = null;
  let error: string | null = null;
  if (client) {
    try {
      msg = await readOpenEmail(db, client, urlId);
      if (!msg) error = 'Job Matrix couldn’t find this email in your mailbox.';
    } catch (e) {
      error =
        e instanceof NeedsSignIn
          ? 'Connect Outlook on Job Matrix’s Email page to read this email.'
          : (e as Error).message;
    }
  }
  // Moved since it was added (a new id): the Message-ID header still finds it.
  const lead =
    (msg?.internetMessageId
      ? db
          .select()
          .from(mailLeads)
          .where(eq(mailLeads.internetMessageId, msg.internetMessageId))
          .get()
      : undefined) ?? stored;
  if (lead && msg && (lead.messageId !== msg.id || lead.conversationId !== msg.conversationId))
    db.update(mailLeads)
      .set({ messageId: msg.id, webLink: msg.webLink, conversationId: msg.conversationId })
      .where(eq(mailLeads.id, lead.id))
      .run();

  const f = msg ? leadFields(msg, leadBody(msg.bodyText)) : null;
  return {
    messageId: msg?.id ?? urlId,
    subject: msg?.subject ?? lead?.subject ?? null,
    from: msg?.from.name ?? msg?.from.address ?? lead?.fromName ?? lead?.fromAddr ?? null,
    receivedAt: msg?.receivedAt ?? lead?.receivedAt ?? null,
    applicationId: lead?.applicationId ?? null,
    detected: {
      title: f && f.title !== 'Unknown role' ? f.title : null,
      company: f && f.company !== 'Unknown' ? f.company : null,
      postingUrl: f?.postingUrl ?? null,
    },
    error,
  };
}

/** "Add to Screening" on an open email: the same as the job-leads folder, for this one email. */
export async function addEmailLead(
  db: Db,
  client: MailClient,
  input: { messageId: string; title?: string; company?: string },
  opts: { fetchFn?: typeof fetch } = {},
) {
  let msg: MailMessage;
  try {
    msg = await client.message(input.messageId);
  } catch (e) {
    // Not the extension token: say what to do instead of a 401 the panel reads as "re-pair".
    if (e instanceof NeedsSignIn)
      throw Object.assign(
        new Error('Connect Outlook on Job Matrix’s Email page, then try again.'),
        { statusCode: 409 },
      );
    throw e;
  }
  const already = msg.internetMessageId
    ? db
        .select()
        .from(mailLeads)
        .where(eq(mailLeads.internetMessageId, msg.internetMessageId))
        .get()
    : undefined;
  if (already?.applicationId) return { applicationId: already.applicationId, existing: true };
  const r = await addLead(
    db,
    client,
    msg,
    { fetchFn: opts.fetchFn, screener: null },
    { message: msg, overrides: { title: input.title, company: input.company } },
  );
  return {
    applicationId: r.applicationId,
    existing: r.existing,
    title: r.title,
    company: r.company,
  };
}
