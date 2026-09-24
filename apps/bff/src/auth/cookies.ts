/**
 * Cookie 名称与读写。
 *
 * 生产环境使用 __Secure- 前缀、Path=/webui/、HttpOnly、Secure、SameSite=Lax，
 * 不设置 Domain（实施文档 4.2）。清除时使用相同名称与 Path。
 */

import type { FastifyReply, FastifyRequest } from 'fastify';
import type { WebuiConfig } from '../config.js';

export interface CookieNames {
  readonly session: string;
  readonly prelogin: string;
}

export function cookieNames(config: WebuiConfig): CookieNames {
  return {
    session: `${config.cookiePrefix}parrot_webui_session`,
    prelogin: `${config.cookiePrefix}parrot_webui_prelogin`,
  };
}

function baseOptions(config: WebuiConfig) {
  return {
    path: config.basePath,
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: config.cookieSecure,
  };
}

export function setSessionCookie(reply: FastifyReply, config: WebuiConfig, value: string): void {
  reply.setCookie(cookieNames(config).session, value, {
    ...baseOptions(config),
    maxAge: config.sessionMaxSeconds,
  });
}

export function clearSessionCookie(reply: FastifyReply, config: WebuiConfig): void {
  reply.clearCookie(cookieNames(config).session, baseOptions(config));
}

export function setPreloginCookie(reply: FastifyReply, config: WebuiConfig, value: string): void {
  reply.setCookie(cookieNames(config).prelogin, value, {
    ...baseOptions(config),
    maxAge: config.bootstrapTtlSeconds,
  });
}

export function clearPreloginCookie(reply: FastifyReply, config: WebuiConfig): void {
  reply.clearCookie(cookieNames(config).prelogin, baseOptions(config));
}

export function readSessionCookie(request: FastifyRequest, config: WebuiConfig): string | undefined {
  return request.cookies?.[cookieNames(config).session];
}

export function readPreloginCookie(request: FastifyRequest, config: WebuiConfig): string | undefined {
  return request.cookies?.[cookieNames(config).prelogin];
}
