/**
 * Kitty in a group chat (KT2, ADR-0062): `/link <pot id>` ties the chat to a pot, `/iam <name>` ties
 * a Telegram user to a test member, then `/pot`, `/why <name>` and `/approve <#>`. Runs only with
 * `KITTY_BOT=on`, and never alongside another poller on the same token (ADR-0060).
 */
import { and, eq } from "drizzle-orm";
import { Bot, InlineKeyboard } from "grammy";
import { type ActionDeps, approve } from "./actions.ts";
import { usd } from "./chain.ts";
import { members, memories, pots, proposals } from "./db/index.ts";

export function createBot(token: string, deps: ActionDeps & { baseUrl: string }, botInfo?: never) {
  const bot = new Bot(token, botInfo ? { botInfo } : {});
  const potOf = async (chatId: number) =>
    (
      await deps.db
        .select()
        .from(pots)
        .where(eq(pots.telegramChatId, String(chatId)))
    )[0];

  bot.command(["start", "help"], (ctx) =>
    ctx.reply("🐱 Kitty: /link <pot id>, /iam <name>, /pot, /why <name>, /approve <#>"),
  );

  bot.command("link", async (ctx) => {
    const id = ctx.match.trim();
    const [pot] = await deps.db.select().from(pots).where(eq(pots.id, id));
    if (!pot) return void (await ctx.reply("No such pot."));
    await deps.db
      .update(pots)
      .set({ telegramChatId: String(ctx.chat.id) })
      .where(eq(pots.id, id));
    await ctx.reply(`Linked to ${pot.name}. ${deps.baseUrl}/pots/${pot.id}`);
  });

  bot.command("iam", async (ctx) => {
    const pot = await potOf(ctx.chat.id);
    if (!pot || !ctx.from) return void (await ctx.reply("Link a pot first: /link <pot id>"));
    const name = ctx.match.trim();
    const [m] = await deps.db
      .select()
      .from(members)
      .where(and(eq(members.potId, pot.id), eq(members.name, name)));
    if (!m) return void (await ctx.reply(`No member called ${name}.`));
    await deps.db
      .update(members)
      .set({ telegramUserId: String(ctx.from.id) })
      .where(and(eq(members.potId, pot.id), eq(members.address, m.address)));
    await ctx.reply(`You're ${m.name}${m.test ? " (test)" : ""}.`);
  });

  bot.command("pot", async (ctx) => {
    const pot = await potOf(ctx.chat.id);
    if (!pot) return void (await ctx.reply("Link a pot first: /link <pot id>"));
    const ms = await deps.db.select().from(members).where(eq(members.potId, pot.id));
    const total = ms.reduce((s, m) => s + m.contributed, 0n);
    const open = await deps.db
      .select()
      .from(proposals)
      .where(and(eq(proposals.potId, pot.id), eq(proposals.executed, false)));
    const kb = new InlineKeyboard();
    for (const p of open) kb.text(`Approve #${p.seq}`, `approve:${pot.id}:${p.seq}`).row();
    await ctx.reply(
      [
        `${pot.name}: ${usd(total)} of ${usd(pot.goal)}`,
        ...ms.map(
          (m) =>
            `• ${m.name}${m.test ? " (test)" : ""}: ${usd(m.contributed)}${m.active ? "" : " (left)"}`,
        ),
        ...open.map(
          (p) =>
            `#${p.seq} ${p.kind === "spend" ? `${p.memo} ${usd(p.amount ?? 0n)}` : p.kind} (${p.approvals.length}/${pot.quorum})`,
        ),
      ].join("\n"),
      open.length ? { reply_markup: kb } : {},
    );
  });

  bot.command("why", async (ctx) => {
    const pot = await potOf(ctx.chat.id);
    if (!pot) return;
    const [m] = await deps.db
      .select()
      .from(members)
      .where(and(eq(members.potId, pot.id), eq(members.name, ctx.match.trim())));
    if (!m?.scheduleMemoryId)
      return void (await ctx.reply("Nothing special: the scheduled share, when due."));
    const [r] = await deps.db.select().from(memories).where(eq(memories.id, m.scheduleMemoryId));
    await ctx.reply(`🧠 ${r?.text ?? "…"}${r?.blobId ? `\nblob ${r.blobId}` : ""}`);
  });

  const approveAs = async (chatId: number, userId: number, seq: number) => {
    const pot = await potOf(chatId);
    if (!pot) return "Link a pot first.";
    const [m] = await deps.db
      .select()
      .from(members)
      .where(and(eq(members.potId, pot.id), eq(members.telegramUserId, String(userId))));
    if (!m) return "Tell me who you are first: /iam <name>";
    const [p] = await deps.db
      .select()
      .from(proposals)
      .where(and(eq(proposals.potId, pot.id), eq(proposals.seq, seq)));
    if (!p) return "No such proposal.";
    const reaches = p.approvals.length + 1 >= pot.quorum;
    try {
      const r = await approve(deps, pot.id, seq, m.address, reaches);
      return reaches
        ? `Approved and done. ${r.digest}`
        : `Approved (${p.approvals.length + 1}/${pot.quorum}).`;
    } catch (err) {
      return `Couldn't approve: ${String((err as Error).message).slice(0, 120)}`;
    }
  };

  bot.command("approve", async (ctx) => {
    if (!ctx.from) return;
    await ctx.reply(
      await approveAs(ctx.chat.id, ctx.from.id, Number(ctx.match.replace("#", "").trim())),
    );
  });

  bot.callbackQuery(/^approve:(.+):(\d+)$/, async (ctx) => {
    const seq = Number(ctx.match[2]);
    const msg = ctx.chat ? await approveAs(ctx.chat.id, ctx.from.id, seq) : "No chat.";
    await ctx.answerCallbackQuery({ text: msg.slice(0, 190) });
  });

  bot.catch((err) => deps.log?.("bot.error", { error: String(err.error) }));
  return bot;
}
