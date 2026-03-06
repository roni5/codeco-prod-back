import express from "express";
import axios from "axios";
import rateLimit from "express-rate-limit";
import pino from "pino";
import Stripe from "stripe";
import bodyParser from "body-parser";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import nodemailer from "nodemailer";

const app = express();
const logger = pino({ level: "info" });

/* =========================
   STRIPE RAW BODY (MUST BE FIRST)
========================= */
app.use("/paymentsuccess", bodyParser.raw({ type: "application/json" }));

/* =========================
   NORMAL JSON FOR OTHER ROUTES
========================= */
app.use(express.json());

app.use(rateLimit({
  windowMs: 60 * 1000,
  max: 100
}));

/* =========================
   CLAUDE CHAT ENDPOINT
========================= */
app.post("/chat", async (req, res) => {
  const { message } = req.body;

  if (!message) {
    return res.status(400).json({ error: "Message required" });
  }

  try {
    const response = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: "claude-3-haiku-20240307",
        max_tokens: 500,
        messages: [{ role: "user", content: message }]
      },
      {
        headers: {
          "x-api-key": process.env.CLAUDE_API_KEY!,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json"
        }
      }
    );

    res.json(response.data);

  } catch (err) {
    logger.error(err);
    res.status(500).json({ error: "Claude API error" });
  }
});

/* =========================
   STRIPE WEBHOOK
========================= */
app.post("/paymentsuccess", async (req, res) => {
  const signature = req.headers["stripe-signature"];
  if (!signature) {
    return res.status(400).json({ error: "No signature found" });
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
    apiVersion: "2023-10-16"
  });

  let event: Stripe.Event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      signature as string,
      process.env.STRIPE_WEBHOOK_SECRET!
    );
  } catch (err: any) {
    logger.error("Stripe signature error:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  logger.info(`Stripe event received: ${event.type}`);

  if (
    event.type === "checkout.session.completed" ||
    event.type === "checkout.session.async_payment_succeeded"
  ) {

    const session = event.data.object as Stripe.Checkout.Session;

    try {
      const items = await stripe.checkout.sessions.listLineItems(session.id, {
        expand: ["data.price.product"]
      });

      const s3 = new S3Client({
        region: process.env.NEXT_AWS_S3_REGION!,
        credentials: {
          accessKeyId: process.env.NEXT_AWS_S3_ACCESS_KEY_ID!,
          secretAccessKey: process.env.NEXT_AWS_S3_SECRET_ACCESS_KEY!,
        }
      });

      for (const item of items.data) {

        if (!item.price?.id) continue;

        const price = await stripe.prices.retrieve(item.price.id);
        const product = await stripe.products.retrieve(price.product as string);

        const filename = product.metadata?.filename;
        if (!filename) {
          logger.warn("No filename metadata on product");
          continue;
        }

        const signedUrl = await getSignedUrl(
          s3,
          new GetObjectCommand({
            Bucket: process.env.NEXT_AWS_S3_BUCKET_NAME!,
            Key: filename
          }),
          { expiresIn: 604800 }
        );

        const tx = nodemailer.createTransport({
          host: "email-smtp.eu-west-1.amazonaws.com",
          port: 587,
          secure: false,
          requireTLS: true,
          auth: {
            user: process.env.AWS_SES_SMTP_USER!,
            pass: process.env.AWS_SES_SMTP_PASSWORD!
          }
        });

        const customerName = session.customer_details?.name || "Customer";
        const to = session.customer_details?.email || "info@codeco.tech";
        const amount = ((item.amount_total || 0) / 100).toFixed(2);

        await tx.sendMail({
          from: process.env.FROM_EMAIL || "info@codeco.tech",
          to,
          subject: "Your Order Confirmation - Codeco.tech",
          html: `
            <h2>Thank you for your order, ${customerName}!</h2>
            <p>Product: <strong>${product.name}</strong></p>
            <p>Total: £${amount}</p>
            <p>Download link (expires in 7 days):</p>
            <a href="${signedUrl}" target="_blank">Download Now</a>
          `
        });

        logger.info(`Order email sent to ${to}`);
      }

    } catch (err: any) {
      logger.error("Stripe handler error:", err.message);
      return res.status(500).json({ error: "Handler failed" });
    }
  }

  return res.json({ received: true });
});

/* =========================
   HEALTH CHECK
========================= */
app.get("/health", (_, res) => {
  res.json({ status: "ok" });
});

app.listen(4000, () => {
  logger.info("AI Router running on port 4000");
});
