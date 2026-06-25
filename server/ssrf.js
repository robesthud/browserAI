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
    // IPv4-mapped IPv6 (::ffff:192.168.x.x) — явная проверка приватности mapped адреса
    if (addr.kind() === 'ipv6') {
      try {
        const v4 = addr.toIPv4Address()
        if (v4 && v4.range() !== 'unicast') return true
      } catch { /* not mapped */ }
    }
    // В новых версиях ipaddr.js range() возвращает 'unicast' | 'private' | 'loopback' | 'linkLocal' | ...
    return addr.range() !== 'unicast'
  } catch {
    return false
  }
}

/**
 * Единая проверка «можно ли ходить на этот хост».
 * Блокирует localhost, *.local, приватные IP и альтернативные формы localhost.
 *
 * @param {string} hostname  — hostname из new URL(...).hostname
 * @returns {boolean} true, если запрос к хосту должен быть запрещён
 */
export function isBlockedHost(hostname) {
  if (!hostname) return true
  // Альтернативные представления localhost/loopback
  // decimal: 2130706433 = 127.0.0.1, hex: 0x7f000001, octal: 0177.0.0.1
  const LOCALHOST_ALIASES = new Set(['0.0.0.0', '[::]', '::1', '0:0:0:0:0:0:0:1'])
  if (LOCALHOST_ALIASES.has(hostname)) return true
  // Десятичное/шестнадцатеричное/восьмеричное представление IP
  if (/^(0x[0-9a-f]+|0[0-7]+|\d+)$/i.test(hostname)) {
    // Пробуем нормализовать через URL — браузер раскроет decimal/octal/hex в dotted notation
    try {
      const parsed = new URL(`http://${hostname}/`).hostname
      if (parsed !== hostname) return isBlockedHost(parsed)
    } catch { /* ignore */ }
    return true // консервативно блокируем нестандартные числовые записи
  }
  return isPrivateIp(hostname) || hostname === 'localhost' || hostname.endsWith('.local')
}
