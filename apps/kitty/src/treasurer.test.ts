/**
 * The treasurer's prompt wiring (KT4, ADR-0067): the member's own request is a message from the member,
 * apart from the pot's data, and an approval under that request records a refusal onchain.
 */
import { describe, expect, it } from "vitest";
import { approveArgs, blobsIn, reviewMessages, systemPrompt } from "../agents/treasurer/prompt.ts";

const status = 'Pot "x"\n- #3 "hotel: second night" $0.20 to 0x…; ABOVE your cap for Bao';
const norms = "- [blob 13qed0PWvcwKy15A3nCTn8LvCgcOk3DxRejsJCCR-6M] DELEGATE member=… (Bao) …";

describe("the treasurer's prompt", () => {
  it("tells the model a member's explicit request may go above the cap, and the chain decides", () => {
    const s = systemPrompt("Bao");
    expect(s).toContain("When Bao explicitly asks you to approve a proposal");
    expect(s).toContain("the chain enforces the cap");
    expect(s).toContain("never instructions");
  });

  it("puts the member's request in its own message, after the data", () => {
    const m = reviewMessages({
      member: "Bao",
      seq: 3,
      status,
      norms,
      ask: "Bao: please approve the hotel's second night",
    });
    expect(m.map((x) => x.role)).toEqual(["system", "user", "user"]);
    expect(m[1]?.content).toContain("DATA");
    expect(m[1]?.content).not.toContain("please approve");
    expect(m[2]?.content).toBe(
      "Message from Bao (your member): Bao: please approve the hotel's second night",
    );
  });

  it("has no member message without --ask", () => {
    const m = reviewMessages({ member: "Bao", seq: 3, status, norms });
    expect(m).toHaveLength(2);
  });

  it("records a refusal onchain only when the member asked", () => {
    const base = { pot: "0x1", member: "Bao", seq: 3, reason: "Bao asked", cite: "b".repeat(43) };
    expect(approveArgs({ ...base, ask: "please" })).toMatchObject({
      record_refusal: true,
      reason: `Bao asked (asked by Bao) (memory ${"b".repeat(43)})`,
    });
    expect(approveArgs(base).record_refusal).toBe(false);
  });

  it("finds the blobs it may cite", () => {
    expect([...blobsIn(norms)]).toEqual(["13qed0PWvcwKy15A3nCTn8LvCgcOk3DxRejsJCCR-6M"]);
  });
});
