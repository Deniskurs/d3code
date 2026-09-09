import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { OmpSettings, ProviderDriverKind, type ServerProvider } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as DateTime from "effect/DateTime";
import { nativeCommands } from "../acp/nativeCommands.ts";
import { HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { expandHomePath } from "../../pathExpansion.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { makeOmpTextGeneration } from "../../textGeneration/OmpTextGeneration.ts";
import { withOmpSearchPath } from "../ompEnvironment.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeOmpAdapter } from "../Layers/OmpAdapter.ts";
import {
  buildInitialOmpProviderSnapshot,
  checkOmpProviderStatus,
  enrichOmpSnapshot,
} from "../Layers/OmpProvider.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import {
  makePackageManagedProviderMaintenanceResolver,
  makeCachedProviderMaintenanceResolution,
  normalizeCommandPath,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "../providerMaintenance.ts";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";

const decodeOmpSettings = Schema.decodeSync(OmpSettings);
const DRIVER_KIND = ProviderDriverKind.make("omp");

function isOmpNativeCommandPath(commandPath: string): boolean {
  const normalized = normalizeCommandPath(commandPath);
  return normalized.endsWith("/omp") || normalized.endsWith("/omp.exe");
}

const UPDATE = makePackageManagedProviderMaintenanceResolver({
  provider: DRIVER_KIND,
  npmPackageName: "@oh-my-pi/pi-coding-agent",
  nativeUpdate: {
    args: ["update"],
    isCommandPath: isOmpNativeCommandPath,
  },
});

export type OmpDriverEnv =
  | BackgroundPolicy.BackgroundPolicy
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | Path.Path
  | ProviderEventLoggers
  | ServerConfig
  | ServerSettingsService;

const withInstanceIdentity =
  (input: {
    readonly instanceId: ProviderInstance["instanceId"];
    readonly displayName: string | undefined;
    readonly accentColor: string | undefined;
    readonly continuationGroupKey: string;
  }) =>
  (snapshot: ServerProviderDraft): ServerProvider => ({
    ...snapshot,
    instanceId: input.instanceId,
    driver: DRIVER_KIND,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    continuation: { groupKey: input.continuationGroupKey },
  });

export const OmpDriver: ProviderDriver<OmpSettings, OmpDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Oh My Pi",
    supportsMultipleInstances: true,
  },
  configSchema: OmpSettings,
  defaultConfig: (): OmpSettings => decodeOmpSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const httpClient = yield* HttpClient.HttpClient;
      const serverSettings = yield* ServerSettingsService;
      const eventLoggers = yield* ProviderEventLoggers;
      const platform = yield* HostProcessPlatform;
      const processEnv = withOmpSearchPath(mergeProviderInstanceEnvironment(environment), platform);
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const stampIdentity = withInstanceIdentity({
        instanceId,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      const effectiveConfig = {
        ...config,
        enabled,
        binaryPath: expandHomePath(config.binaryPath),
      } satisfies OmpSettings;
      const fileSystem = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      const resolveMaintenance = yield* makeCachedProviderMaintenanceResolution(
        resolveProviderMaintenanceCapabilitiesEffect(UPDATE, {
          binaryPath: effectiveConfig.binaryPath,
          env: processEnv,
        }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, pathService),
        ),
      );

      const catalogs = yield* SubscriptionRef.make<
        NonNullable<ServerProvider["workspaceSnapshots"]>
      >([]);
      const withCatalogs = (
        base: ServerProvider,
        entries: NonNullable<ServerProvider["workspaceSnapshots"]>,
      ): ServerProvider => ({
        ...base,
        workspaceSnapshots: entries,
      });
      const adapter = yield* makeOmpAdapter(effectiveConfig, {
        onAvailableCommands: (commands, cwd) =>
          Effect.gen(function* () {
            const checkedAt = DateTime.formatIso(yield* DateTime.now);
            yield* SubscriptionRef.update(catalogs, (entries) =>
              [
                ...entries.filter((entry) => entry.cwd !== cwd),
                { cwd, checkedAt, slashCommands: nativeCommands(commands), skills: [] },
              ].slice(-32),
            );
          }),
        environment: processEnv,
        ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
        instanceId,
      });
      const textGeneration = yield* makeOmpTextGeneration(effectiveConfig, processEnv);
      const checkProvider = checkOmpProviderStatus(effectiveConfig, processEnv).pipe(
        Effect.map(stampIdentity),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
      const snapshotSettings = makeProviderSnapshotSettingsSource(effectiveConfig, serverSettings);
      const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<OmpSettings>>({
        resolveMaintenance,
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (settings) =>
          buildInitialOmpProviderSnapshot(settings.provider).pipe(Effect.map(stampIdentity)),
        checkProvider,
        enrichSnapshot: ({ settings, snapshot: currentSnapshot, publishSnapshot }) =>
          resolveMaintenance({ fresh: true }).pipe(
            Effect.flatMap((maintenanceCapabilities) =>
              enrichOmpSnapshot({
                snapshot: currentSnapshot,
                maintenanceCapabilities,
                enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
                publishSnapshot,
                httpClient,
              }),
            ),
          ),
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: "Failed to build the Oh My Pi provider snapshot.",
              cause,
            }),
        ),
      );

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot: {
          ...snapshot,
          getSnapshot: Effect.all([snapshot.getSnapshot, SubscriptionRef.get(catalogs)]).pipe(
            Effect.map(([base, entries]) => withCatalogs(base, entries)),
          ),
          refresh: snapshot.refresh.pipe(
            Effect.flatMap((base) =>
              SubscriptionRef.get(catalogs).pipe(
                Effect.map((entries) => withCatalogs(base, entries)),
              ),
            ),
          ),
          streamChanges: snapshot.streamChanges.pipe(
            Stream.mapEffect((base) =>
              SubscriptionRef.get(catalogs).pipe(
                Effect.map((entries) => withCatalogs(base, entries)),
              ),
            ),
            Stream.merge(
              SubscriptionRef.changes(catalogs).pipe(
                Stream.mapEffect((entries) =>
                  snapshot.getSnapshot.pipe(Effect.map((base) => withCatalogs(base, entries))),
                ),
              ),
            ),
          ),
        },
        adapter,
        textGeneration,
      } satisfies ProviderInstance;
    }),
};
