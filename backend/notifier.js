// Supervisor notifications: always logged + stored; optionally POSTed to a webhook
// (Slack incoming webhook, n8n, Make, etc.) set in SUPERVISOR_WEBHOOK_URL.
function createNotifier({ store, webhookUrl = "", log = console }) {
  return {
    async notify(alert) {
      const n = { id: `NTF-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, alert_id: alert.id, channel: webhookUrl ? "webhook" : "log",
        to: "supervisor", message: alert.message, severity: alert.severity, sewer_id: alert.sewer_id, created_at: new Date().toISOString(), delivered: false };
      log.warn?.(`[SUPERVISOR] ${alert.severity} ${alert.sewer_id}: ${alert.message}`);
      if (webhookUrl) {
        try {
          const res = await fetch(webhookUrl, { method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ text: `SewerSafe ${alert.severity} · ${alert.sewer_id} · ${alert.message}`, alert }), signal: AbortSignal.timeout(4000) });
          n.delivered = res.ok; n.http_status = res.status;
        } catch (e) { n.error = e.message; }
      } else n.delivered = true;
      await store.insert("notifications", n);
      return n;
    },
  };
}
module.exports = { createNotifier };
