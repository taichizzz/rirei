import { randomUUID } from 'node:crypto';
import { hostname, uptime } from 'node:os';
import type { ControllerIdentity, ControllerKind } from '../state/schema.js';

export interface ControllerOptions {
  kind?: ControllerKind;
  /** Desktop-owned runs reuse the terminal id as their instance identity. */
  terminalId?: string;
  /** Optional existing identity reused for idempotent re-attachment. */
  identity?: ControllerIdentity;
}

/**
 * Build a collision-proof controller identity. CLI/desktop/daemon controllers
 * get a fresh uuid, so a pid reused after a reboot can never alias an old
 * controller; terminal-owned controllers reuse the terminal id so heartbeats
 * and orphaning match the terminal that owns the provider process.
 */
export function buildControllerIdentity(
  options: ControllerOptions = {},
): ControllerIdentity {
  if (options.identity) return options.identity;
  const terminal = options.terminalId;
  const kind: ControllerKind = terminal ? 'desktop' : (options.kind ?? 'cli');
  return {
    kind,
    instanceId: terminal ?? randomUUID(),
    pid: process.pid,
    bootId: currentBootId(),
  };
}

/** Stable for the current boot and host without reading privileged system data. */
export function currentBootId(now = Date.now()): string {
  const bootMinute = Math.round((now - uptime() * 1000) / 60_000);
  return `${hostname()}:${bootMinute}`;
}

/** The canonical lease `controllerId` string for a structured identity. */
export function controllerIdFor(identity: ControllerIdentity): string {
  return `${identity.kind}:${identity.bootId}:${identity.instanceId}`;
}
