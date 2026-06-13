import { describe, expect, it } from 'vitest'
import { createNotification, listNotifications, markAllNotificationsRead, markNotificationRead, notificationSummary } from '../server/notifications.js'

describe('notification center', () => {
  it('creates, lists and marks notifications read', () => {
    const userId = `ntf-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const n = createNotification({ userId, kind: 'test', severity: 'high', title: 'Test notification', message: 'hello', entityType: 'test', entityId: '1', channels: { push: false, telegram: false } })
    expect(n.id).toMatch(/^ntf-/)
    const list = listNotifications({ userId })
    expect(list.some((x) => x.id === n.id)).toBe(true)
    expect(notificationSummary({ userId }).unread).toBeGreaterThan(0)
    expect(markNotificationRead({ userId, id: n.id }).updated).toBe(1)
    expect(markAllNotificationsRead({ userId }).updated).toBeGreaterThanOrEqual(0)
  })
})
