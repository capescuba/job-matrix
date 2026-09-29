/**
 * Other names a company goes by — "SpaceXAI" for Cursor after an acquisition, a parent brand, an
 * old name — so emails and job pages that use them still match the company you track.
 */
import { asc, eq } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { companies, companyAliases } from '../db/schema.ts';
import { NotFoundError } from './applications.ts';
import { companyKey } from './extension.ts';

export class AliasError extends Error {}

export function listAliases(db: Db, companyId: number) {
  return db
    .select({
      id: companyAliases.id,
      alias: companyAliases.alias,
      createdAt: companyAliases.createdAt,
    })
    .from(companyAliases)
    .where(eq(companyAliases.companyId, companyId))
    .orderBy(asc(companyAliases.alias))
    .all();
}

/** Every alias, keyed the way names are compared. */
export function allAliases(db: Db) {
  return db
    .select({
      companyId: companyAliases.companyId,
      alias: companyAliases.alias,
      key: companyAliases.aliasKey,
    })
    .from(companyAliases)
    .all();
}

/**
 * Records `alias` as another name for the company. An alias another company had moves here;
 * the name of a different tracked company can't become an alias.
 */
export function addAlias(db: Db, companyId: number, alias: string) {
  const name = alias.replace(/\s+/g, ' ').trim();
  const key = companyKey(name);
  if (!key) throw new AliasError('Give a name.');
  const company = db.select().from(companies).where(eq(companies.id, companyId)).get();
  if (!company) throw new NotFoundError(`Company ${companyId} not found`);
  if (companyKey(company.name) === key) return null; // it's already the company's own name
  const clash = db
    .select({ id: companies.id, name: companies.name })
    .from(companies)
    .all()
    .find((c) => c.id !== companyId && companyKey(c.name) === key);
  if (clash)
    throw new AliasError(`“${name}” is the name of another company you track (${clash.name}).`);
  const existing = db.select().from(companyAliases).where(eq(companyAliases.aliasKey, key)).get();
  if (existing) {
    db.update(companyAliases)
      .set({ companyId, alias: name })
      .where(eq(companyAliases.id, existing.id))
      .run();
    return db.select().from(companyAliases).where(eq(companyAliases.id, existing.id)).get()!;
  }
  return db
    .insert(companyAliases)
    .values({ companyId, alias: name, aliasKey: key })
    .returning()
    .get();
}

export function removeAlias(db: Db, id: number) {
  const res = db.delete(companyAliases).where(eq(companyAliases.id, id)).run();
  if (res.changes === 0) throw new NotFoundError(`Alias ${id} not found`);
}
