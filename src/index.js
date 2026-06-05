export default {
  async email(message, env, ctx) {

    const from = message.from;
    const to = message.to;
    const subject = message.headers.get("subject") || "(no subject)";
    const messageId = message.headers.get("message-id") || crypto.randomUUID();
    const inboxName = to.split("@")[0].toLowerCase();

    // ============================================
    // AI SPAM FILTER (Free tier only)
    // Drops obvious spam before it hits Redis
    // ============================================
    try {
      const classification = await env.AI.run(
  "@cf/meta/llama-3.1-8b-instruct",
        {
          messages: [
            {
              role: "system",
              content: "You are a spam classifier for a developer email testing tool. Your job is to identify automated spam and bot-generated emails. Legitimate emails include: password resets, email verification links, signup confirmations, OTP codes, and developer test emails. Reply with ONLY one word: SPAM or LEGITIMATE."
            },
            {
              role: "user",
              content: `Classify this email:
From: ${from}
Subject: ${subject}

Reply with only SPAM or LEGITIMATE.`
            }
          ],
          max_tokens: 10,
        }
      );

      const result = classification?.response?.trim().toUpperCase();

      if (result === "SPAM") {
        console.log(`[ZeroDrop] Dropped spam from ${from} — subject: ${subject}`);
        return; // Silent drop — never hits Redis
      }

    } catch (aiError) {
      // If AI fails, allow the email through
      // Never drop legitimate emails due to AI errors
      console.log(`[ZeroDrop] AI filter error — allowing email through: ${aiError.message}`);
    }

    // ============================================
    // PARSE EMAIL
    // ============================================
    const rawEmail = await new Response(message.raw).text();

    const emailPayload = {
      id: messageId,
      from,
      to,
      subject,
      receivedAt: new Date().toISOString(),
      raw: rawEmail,
    };

    // ============================================
    // PUSH TO REDIS
    // ============================================
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

    // Set 30 minute TTL
    await fetch(
      `${env.UPSTASH_REDIS_REST_URL}/expire/inbox:${inboxName}/1800`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`,
        },
      }
    );

    console.log(`[ZeroDrop] Email from ${from} → inbox:${inboxName}`);
  },
};