/**
 * ssrf.js — общие помощники SSRF-защиты.
 *
 * Раньше функция isPrivateIp и одинаковая 5-строчная проверка хоста были
 * скопированы в index.js по пять раз. Вынесено сюда, чтобы единая логика
 * блокировки внутренних адресов жила в одном месте.
 */
import { isIP as isIp } from 'is-ip'
import ipaddr from 'ipaddr.js'

/**
 * true, если адрес — приватный/loopback/link-local и т.п. (не публичный unicast).
 * Возвращает false для не-IP (доменных имён) — их проверяет isBlockedHost.
 */
export function isPrivateIp(address) {
  if (!isIp(address)) return false
  try {
    const addr = ipaddr.parse(address)
    // В новых версиях ipaddr.js isLoopback/isLinkLocal удалены — range()
    // возвращает 'unicast' | 'private' | 'loopback' | 'linkLocal' | ...
    return addr.range() !== 'unicast'
  } catch {
    return false
  }
}

/**
 * Единая проверка «можно ли ходить на этот хост».
 * Блокирует localhost, *.local и приватные IP.
 *
 * @param {string} hostname  — hostname из new URL(...).hostname
 * @returns {boolean} true, если запрос к хосту должен быть запрещён
 */
export function isBlockedHost(hostname) {
  if (!hostname) return true
  return isPrivateIp(hostname) || hostname === 'localhost' || hostname.endsWith('.local')
}
