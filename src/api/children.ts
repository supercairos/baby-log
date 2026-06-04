/**
 * Children + the authenticated user's profile.
 */
import type { components } from "./generated/schema";
import type { BabyBuddyClient } from "./client";
import { unwrap } from "./errors";

export type Child = components["schemas"]["Child"];

/** List the children on the instance (also the canonical connection-validation call). */
export async function listChildren(client: BabyBuddyClient): Promise<Child[]> {
  const res = await client.GET("/api/children/", {});
  return unwrap(res).results ?? [];
}

/** A child's display name, falling back gracefully if a name part is missing. */
export function childName(child: Child): string {
  return [child.first_name, child.last_name].filter(Boolean).join(" ").trim() || `Child ${child.id ?? ""}`.trim();
}
