import { OmpSessionsError, type OmpSavedSession } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

type SessionPage = {
  sessions: ReadonlyArray<typeof OmpSavedSession.Type>;
  nextCursor?: string | null | undefined;
};

/** The caller lists the whole profile so an ID is independent of the selected project. */
export function findOmpSession<E>(
  sessionId: string,
  list: (cursor?: string) => Effect.Effect<SessionPage, E>,
) {
  return Effect.gen(function* () {
    let cursor: string | undefined;
    const visited = new Set<string>();
    for (let pageIndex = 0; pageIndex < 100; pageIndex++) {
      const page = yield* list(cursor);
      const found = page.sessions.find((entry) => entry.sessionId === sessionId);
      if (found) return found;
      if (!page.nextCursor || visited.has(page.nextCursor)) break;
      visited.add(page.nextCursor);
      cursor = page.nextCursor;
    }
    return yield* new OmpSessionsError({
      message:
        "This OMP session was not found in this provider profile. Check the session ID and the selected OMP profile.",
    });
  });
}
