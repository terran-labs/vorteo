import { readFile } from "node:fs/promises";
import { z } from "zod";

const pageSchema = z.object({
  count: z.number().int().nonnegative(),
  contacts: z.array(
    z.object({
      id: z.number().int(),
      emailBlacklisted: z.boolean(),
      email: z.string().optional(),
      listUnsubscribed: z.array(z.number()).optional(),
      attributes: z.object({ SOURCES: z.string().nullish() }).optional(),
    }),
  ),
});

interface NewsletterSettings {
  listId: number;
  apiKeyFile: string;
  sourceNames?: string[];
}

export async function collectNewsletter(settings: NewsletterSettings, signal: AbortSignal) {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(60_000)]);
  const key = (await readFile(settings.apiKeyFile, { encoding: "utf8", signal: deadline })).trim();
  const endpoint = new URL(`https://api.brevo.com/v3/contacts/lists/${settings.listId}/contacts`);
  endpoint.searchParams.set("sort", "asc");
  endpoint.searchParams.set("limit", "500");
  const seen = new Set<number>();
  const sources = new Map((settings.sourceNames ?? []).map((name) => [name, 0]));
  let expected: number | undefined;
  let eligible = 0;
  do {
    endpoint.searchParams.set("offset", String(seen.size));
    const response = await fetch(endpoint, {
      headers: { "api-key": key },
      signal: AbortSignal.any([deadline, AbortSignal.timeout(10_000)]),
      redirect: "error",
    });
    if (!response.ok) throw new Error("Brevo list read failed");
    const page = pageSchema.parse(await response.json());
    expected ??= page.count;
    if (page.count !== expected || (page.contacts.length === 0 && seen.size < expected))
      throw new Error("Brevo list changed during collection");
    for (const contact of page.contacts) {
      if (seen.has(contact.id)) throw new Error("Brevo list page overlapped");
      seen.add(contact.id);
      if (
        !contact.email ||
        contact.emailBlacklisted ||
        contact.listUnsubscribed?.includes(settings.listId)
      )
        continue;
      eligible++;
      // Persist only configured source names. Contact attributes may contain private free text.
      for (const name of new Set(contact.attributes?.SOURCES?.split(",").map((s) => s.trim()))) {
        const count = sources.get(name);
        if (count !== undefined) sources.set(name, count + 1);
      }
    }
  } while (seen.size < expected);
  if (seen.size !== expected) throw new Error("Incomplete Brevo list");
  const values: Record<string, number> = { newsletterEligible: eligible };
  for (const [name, count] of sources) values["newsletterSource:" + name] = count;
  return values;
}
