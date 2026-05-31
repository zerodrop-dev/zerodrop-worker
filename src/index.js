export default {
  async email(message, env, ctx) {
    // Extract basic email metadata
    const from = message.from;
    const to = message.to;
    const subject = message.headers.get("subject") || "(no subject)";
    const messageId = message.headers.get("message-id") || crypto.randomUUID();

    // Extract the inbox name from the "to" address
    // e.g. "test-593@zerodrop-sandbox.online" → "test-593"
    const inboxName = to.split("@")[0].toLowerCase();

    // Read the raw email body
    const rawEmail = await new Response(message.raw).text();

    // Build the JSON payload
    const emailPayload = {
      id: messageId,
      from: from,
      to: to,
      subject: subject,
      receivedAt: new Date().toISOString(),
      raw: rawEmail,
    };

    // Push to Upstash Redis
    // Key pattern: inbox:{inboxName}
    // We use LPUSH to maintain a list of emails per inbox
    const redisUrl = `${env.UPSTASH_REDIS_REST_URL}/lpush/inbox:${inboxName}`;
    
    const response = await fetch(redisUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify([JSON.stringify(emailPayload)]),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to push to Redis: ${error}`);
    }

    // Set 30 minute TTL on the inbox key
    const ttlUrl = `${env.UPSTASH_REDIS_REST_URL}/expire/inbox:${inboxName}/1800`;
    
    await fetch(ttlUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`,
      },
    });

    console.log(`Email from ${from} pushed to inbox:${inboxName}`);
  },
};