/**
 * PropertySales AI — Demo data seeder
 *
 * Seeds the wacrm database with Pakistani real estate demo data.
 * Run AFTER you've deployed and signed up at the app.
 *
 * Usage:
 *   npx tsx scripts/seed.ts your@email.com
 *
 * Requires these env vars (set in .env.local or export them):
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 */

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { resolve } from "path";

const email = process.argv[2];
if (!email) {
  console.error("Usage: npx tsx scripts/seed.ts your@email.com");
  process.exit(1);
}

// Load env from .env.local if it exists
let supabaseUrl = process.env.SUPABASE_URL;
let serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !serviceRoleKey) {
  try {
    const envPath = resolve(__dirname, "..", ".env.local");
    const envContent = readFileSync(envPath, "utf-8");
    const urlMatch = envContent.match(
      /^NEXT_PUBLIC_SUPABASE_URL=(.+)$/m
    );
    const keyMatch = envContent.match(
      /^SUPABASE_SERVICE_ROLE_KEY=(.+)$/m
    );
    if (urlMatch) supabaseUrl = urlMatch[1].trim();
    if (keyMatch) serviceRoleKey = keyMatch[1].trim();
  } catch {
    console.error(
      "Could not find env vars. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local or export them."
    );
    process.exit(1);
  }
}

if (!supabaseUrl || !serviceRoleKey) {
  console.error(
    "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. Check your .env.local file."
  );
  process.exit(1);
}

const supabase = createClient(supabaseUrl!, serviceRoleKey!, {
  auth: { persistSession: false },
});

async function seed() {
  console.log(`Looking up user: ${email}`);
  const { data: userData, error: userError } = await supabase
    .from("profiles")
    .select("id, account_id, full_name")
    .eq("email", email)
    .single();

  if (userError || !userData) {
    console.error(
      `User "${email}" not found. Have you signed up at the app yet?`
    );
    console.error(userError);
    process.exit(1);
  }

  const userId = userData.id;
  const accountId = userData.account_id;
  console.log(`Found: ${userData.full_name} (account: ${accountId})`);

  // ─── Demo Tags ───────────────────────────────────────────
  const tags = [
    { name: "Hot Buyer", color: "#ef4444" },
    { name: "Diaspora", color: "#8b5cf6" },
    { name: "File Investor", color: "#f59e0b" },
    { name: "Site Visit Done", color: "#10b981" },
    { name: "Installment", color: "#3b82f6" },
  ];
  const tagIds: Record<string, string> = {};
  for (const tag of tags) {
    const { data } = await supabase
      .from("tags")
      .insert({
        user_id: userId,
        account_id: accountId,
        name: tag.name,
        color: tag.color,
      })
      .select("id")
      .single();
    if (data) tagIds[tag.name] = data.id;
  }
  console.log(`✓ ${tags.length} tags created`);

  // ─── Demo Contacts ───────────────────────────────────────
  const contacts = [
    {
      phone: "+923001234567",
      name: "Ahmed Raza",
      email: "ahmed.raza@gmail.com",
    },
    {
      phone: "+923112345678",
      name: "Fatima Tariq",
      email: "fatima.t@yahoo.com",
    },
    {
      phone: "+923223456789",
      name: "Omar Khalid",
      email: "omar.k@hotmail.com",
    },
    {
      phone: "+923334567890",
      name: "Sana Mahmood",
      email: "sana.m@gmail.com",
    },
    {
      phone: "+923445678901",
      name: "Bilal Hussain",
      email: "bilal.h@outlook.com",
    },
    {
      phone: "+923556789012",
      name: "Zainab Ali",
      email: "zainab.a@gmail.com",
    },
    {
      phone: "+447123456789",
      name: "Tariq Mehmood (UK)",
      email: "tariq.uk@gmail.com",
    },
    {
      phone: "+971501234567",
      name: "Farhan Sheikh (Dubai)",
      email: "farhan.dxb@yahoo.com",
    },
    {
      phone: "+923667890123",
      name: "Rabia Anwar",
      email: "rabia.a@gmail.com",
    },
    {
      phone: "+923778901234",
      name: "Usman Ghani",
      email: "usman.g@yahoo.com",
    },
  ];
  const contactIds: string[] = [];
  for (const c of contacts) {
    const { data } = await supabase
      .from("contacts")
      .insert({
        user_id: userId,
        account_id: accountId,
        phone: c.phone,
        name: c.name,
        email: c.email,
      })
      .select("id")
      .single();
    if (data) contactIds.push(data.id);
  }
  console.log(`✓ ${contactIds.length} contacts created`);

  // ─── Tag some contacts ──────────────────────────────────
  await supabase.from("contact_tags").insert([
    { contact_id: contactIds[0], tag_id: tagIds["Hot Buyer"] },
    { contact_id: contactIds[6], tag_id: tagIds["Diaspora"] },
    { contact_id: contactIds[7], tag_id: tagIds["Diaspora"] },
    { contact_id: contactIds[2], tag_id: tagIds["File Investor"] },
    { contact_id: contactIds[3], tag_id: tagIds["Site Visit Done"] },
    { contact_id: contactIds[4], tag_id: tagIds["Installment"] },
  ]);

  // ─── Demo Conversations + Messages ─────────────────────
  const conversations = [
    {
      contact_id: contactIds[0],
      messages: [
        { text: "Assalam-o-Alaikum! DHA Phase 6 mein 10 marla house chahiye, budget 4 crore hai.", sender: "customer" },
        { text: "Wa Alaikum Assalam! 10 marla, DHA Phase 6, 4 crore budget. Kya furnished chahiye?", sender: "bot" },
        { text: "Jee furnished, possession ready hona chahiye.", sender: "customer" },
        { text: "Mere paas 3 options hain. DHA Phase 6 mein 10 marla furnished, 3.8 crore se 4.2 crore.", sender: "bot" },
        { text: "3.8 crore wali dekhni hai. Kab dikha sakte hain?", sender: "customer" },
        { text: "Kal 2 baje site visit fix kar deta hoon.", sender: "agent" },
      ],
      last_ts: "2026-07-28T14:30:00Z",
    },
    {
      contact_id: contactIds[1],
      messages: [
        { text: "Bahria Town Islamabad mein 5 marla plot chahiye installments pe", sender: "customer" },
        { text: "Budget kya hai? Kisi specific block mein?", sender: "bot" },
        { text: "30 lakh Tak, block C ya D", sender: "customer" },
        { text: "Block C mein 5 marla 28 lakh hai, monthly 15k installment. Block D thoda expensive hai.", sender: "bot" },
        { text: "Block C theek hai. File transfer hai ya society se direct?", sender: "customer" },
        { text: "File transfer hai. Balloting ho chuki hai, possession next year.", sender: "bot" },
      ],
      last_ts: "2026-07-27T11:00:00Z",
    },
    {
      contact_id: contactIds[6],
      messages: [
        { text: "Hi, I'm looking for a 1 kanal house in DHA Lahore. Budget around 7 crore.", sender: "customer" },
        { text: "Hello! 1 kanal, DHA Lahore. Phase 8 or Phase 9 preference?", sender: "bot" },
        { text: "Phase 8 preferably. Can do video tour first — I'm in the UK.", sender: "customer" },
        { text: "Yes, video tour can be arranged. Also have a VR walkthrough option.", sender: "bot" },
      ],
      last_ts: "2026-07-26T09:15:00Z",
    },
    {
      contact_id: contactIds[2],
      messages: [
        { text: "DHA ka 5 marla file chahiye investment ke liye", sender: "customer" },
        { text: "Kisi specific phase mein? Budget kya hai?", sender: "bot" },
        { text: "Phase 8 ya 9, 25 lakh ke andar", sender: "customer" },
        { text: "Dono phases mein files available hain. Balloting kab tak expect karte hain?", sender: "bot" },
        { text: "Jald balloting wali prefer hai. Phase 8 mein 22 lakh hai file", sender: "customer" },
      ],
      last_ts: "2026-07-25T16:45:00Z",
    },
    {
      contact_id: contactIds[3],
      messages: [
        { text: "Gulberg mein 2 bed apartment chahihe, rent pe", sender: "customer" },
        { text: "Budget kya hai rent ka?", sender: "bot" },
        { text: "50 se 70 hazar", sender: "customer" },
        { text: "Kal site visit kar ke aayen. 2 achhe options hain.", sender: "agent" },
        { text: "Jee kal milte hain 3 baje", sender: "customer" },
      ],
      last_ts: "2026-07-24T10:00:00Z",
    },
  ];

  const convIds: string[] = [];
  for (const conv of conversations) {
    const { data: convData } = await supabase
      .from("conversations")
      .insert({
        user_id: userId,
        account_id: accountId,
        contact_id: conv.contact_id,
        status: "open",
        last_message_text: conv.messages[conv.messages.length - 1].text,
        last_message_at: conv.last_ts,
        unread_count: Math.floor(Math.random() * 3),
      })
      .select("id")
      .single();
    if (!convData) continue;
    convIds.push(convData.id);

    for (let i = 0; i < conv.messages.length; i++) {
      const msg = conv.messages[i];
      const ts = new Date(
        new Date(conv.last_ts).getTime() -
          (conv.messages.length - i) * 60000 * 60
      ).toISOString();

      await supabase.from("messages").insert({
        conversation_id: convData.id,
        sender_type: msg.sender === "customer" ? "customer" : msg.sender === "agent" ? "agent" : "bot",
        content_type: "text",
        content_text: msg.text,
        sender_id: msg.sender === "customer" ? null : userId,
        status: "read",
        created_at: ts,
      });
    }
  }
  console.log(`✓ ${conversations.length} conversations with messages`);

  // ─── Demo Pipeline + Stages ─────────────────────────────
  const realEstateStages = [
    { name: "New Lead", color: "#3b82f6", pos: 0 },
    { name: "Qualified", color: "#8b5cf6", pos: 1 },
    { name: "Property Sent", color: "#f59e0b", pos: 2 },
    { name: "Visit Scheduled", color: "#ec4899", pos: 3 },
    { name: "Negotiation", color: "#f97316", pos: 4 },
    { name: "Closed Won", color: "#10b981", pos: 5 },
    { name: "Closed Lost", color: "#ef4444", pos: 6 },
  ];

  const { data: pipeline } = await supabase
    .from("pipelines")
    .insert({
      user_id: userId,
      account_id: accountId,
      name: "Real Estate Pipeline",
    })
    .select("id")
    .single();

  if (!pipeline) {
    console.error("Failed to create pipeline");
    process.exit(1);
  }

  const stageIds: Record<string, string> = {};
  for (const stage of realEstateStages) {
    const { data: s } = await supabase
      .from("pipeline_stages")
      .insert({
        pipeline_id: pipeline.id,
        name: stage.name,
        position: stage.pos,
        color: stage.color,
      })
      .select("id")
      .single();
    if (s) stageIds[stage.name] = s.id;
  }
  console.log(`✓ Pipeline with ${realEstateStages.length} stages`);

  // ─── Demo Deals ─────────────────────────────────────────
  const deals = [
    {
      contact_idx: 0,
      stage: "Visit Scheduled",
      title: "DHA Phase 6 - 10 Marla House",
      value: 38000000,
    },
    {
      contact_idx: 1,
      stage: "Qualified",
      title: "Bahria Town - 5 Marla Plot",
      value: 2800000,
    },
    {
      contact_idx: 6,
      stage: "Property Sent",
      title: "DHA Lahore - 1 Kanal House",
      value: 70000000,
    },
    {
      contact_idx: 2,
      stage: "New Lead",
      title: "DHA Phase 8 - 5 Marla File",
      value: 2200000,
    },
    {
      contact_idx: 3,
      stage: "Visit Scheduled",
      title: "Gulberg - 2 Bed Apartment (Rent)",
      value: 60000,
    },
  ];
  for (const deal of deals) {
    await supabase.from("deals").insert({
      user_id: userId,
      account_id: accountId,
      pipeline_id: pipeline.id,
      stage_id: stageIds[deal.stage],
      contact_id: contactIds[deal.contact_idx],
      title: deal.title,
      value: deal.value,
      currency: "PKR",
      status: "active",
    });
  }
  console.log(`✓ ${deals.length} deals created`);

  // ─── Demo Templates ─────────────────────────────────────
  const templates = [
    {
      name: "re_followup_day1",
      body:
        "Assalam-o-Alaikum! Kal aapne ________ ki inquiry ki thi. Kya aap visit schedule karna chahenge?",
      category: "Marketing",
    },
    {
      name: "re_followup_day3",
      body:
        "Aapki requirement ke mutabiq humare paas naye options aaye hain. Dekhna chahenge?",
      category: "Marketing",
    },
    {
      name: "re_alert_new_property",
      body:
        "Aapki requirement ke mutabiq nayi property available hui hai. Tafseelat: ________",
      category: "Marketing",
    },
  ];
  for (const t of templates) {
    await supabase.from("message_templates").insert({
      user_id: userId,
      account_id: accountId,
      name: t.name,
      body_text: t.body,
      category: t.category,
      language: "ur",
      status: "Approved",
    });
  }
  console.log(`✓ ${templates.length} message templates`);

  // ─── Demo AI Config (disabled, just so it shows) ──────
  await supabase.from("ai_configs").insert({
    account_id: accountId,
    provider: "openai",
    model: "gpt-4",
    is_active: false,
    auto_reply_enabled: false,
    auto_reply_max_per_conversation: 10,
    system_prompt:
      "You are PropertySales AI — a Pakistani real estate assistant. Speak in Roman Urdu.",
  });

  console.log("\n✓ Demo data seeded successfully!");
  console.log("\nLogin at the app → Go to Inbox, Pipeline, Contacts to see everything.");
}

seed().catch(console.error);
