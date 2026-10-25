/** "Start a pot": the connected wallet creates it onchain (sponsored), then joins like anyone else. */
import { type FormEvent, useState } from "react";
import { useNavigate } from "react-router";
import { useSponsored } from "@/api";
import { Field, SelectField, TxStatus } from "@/components/kitty";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { NativeSelectOption } from "@/components/ui/native-select";

const WINDOWS = [
  { label: "every hour", minutes: 60 },
  { label: "every day", minutes: 60 * 24 },
  { label: "every week", minutes: 60 * 24 * 7 },
];

const inDays = (d: number) => {
  const t = new Date(Date.now() + d * 86_400_000);
  t.setMinutes(0, 0, 0);
  // `datetime-local` wants local time without a zone.
  return new Date(t.getTime() - t.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};

export function StartPot({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const tx = useSponsored();
  const [name, setName] = useState("");
  const [goal, setGoal] = useState("1.00");
  const [deadline, setDeadline] = useState(inDays(14));
  const [quorum, setQuorum] = useState("2");
  const [windowMinutes, setWindowMinutes] = useState(60 * 24 * 7);
  const [autoOk, setAutoOk] = useState("0");

  async function submit(e: FormEvent) {
    e.preventDefault();
    const r = await tx.run<{ potId: string; digest: string }>({
      action: "create",
      name: name.trim(),
      goalUsd: Number(goal),
      deadline: new Date(deadline).toISOString(),
      quorum: Number(quorum),
      autoOkUsd: Number(autoOk),
      windowMinutes,
    });
    if (r) navigate(`/pots/${r.potId}?created=${r.digest}`);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Start a pot</CardTitle>
        <CardDescription>
          The pot is a shared object on Sui. You set the goal and the rules; the contract enforces
          them. Then you and your friends join, each with one signature.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="flex max-w-2xl flex-col gap-4">
          <Field
            label="Name"
            required
            maxLength={60}
            placeholder="Da Lat trip"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Goal ($)"
              type="number"
              inputMode="decimal"
              min="0.01"
              step="0.01"
              required
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
            />
            <Field
              label="By"
              type="datetime-local"
              required
              value={deadline}
              onChange={(e) => setDeadline(e.target.value)}
            />
            <Field
              label="Approvals to spend"
              type="number"
              min="1"
              max="50"
              step="1"
              required
              value={quorum}
              onChange={(e) => setQuorum(e.target.value)}
              hint="The quorum: how many members approve a spend or a rule change."
            />
            <Field
              label="Auto-ok up to ($)"
              type="number"
              inputMode="decimal"
              min="0"
              step="0.01"
              value={autoOk}
              onChange={(e) => setAutoOk(e.target.value)}
              hint="Spends this small need no vote. 0 means every spend is voted."
            />
          </div>
          <SelectField
            label="Kitty pulls each share"
            className="w-full"
            value={windowMinutes}
            onChange={(e) => setWindowMinutes(Number(e.target.value))}
          >
            {WINDOWS.map((w) => (
              <NativeSelectOption key={w.minutes} value={w.minutes}>
                at most once per window, {w.label}
              </NativeSelectOption>
            ))}
          </SelectField>
          <TxStatus step={tx.step} error={tx.error} />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={tx.busy || !name.trim()}>
              Create the pot
            </Button>
            <Button type="button" variant="outline" onClick={onClose} disabled={tx.busy}>
              Cancel
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
