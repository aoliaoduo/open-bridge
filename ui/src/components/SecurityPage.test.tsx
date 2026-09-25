import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SecurityPage } from "./SecurityPage";
import type { SettingsState, SettingsTokenRow } from "../api";

const { statusMock } = vi.hoisted(() => ({ statusMock: vi.fn() }));
vi.mock("../api", async importOriginal => {
  const actual = await importOriginal<typeof import("../api")>();
  return { ...actual, api: { status: statusMock, oauth: vi.fn().mockResolvedValue(null) } };
});

const token = (over: Partial<SettingsTokenRow> = {}): SettingsTokenRow => ({
  id: "tok_abcdef",
  label: "chatgpt-web",
  created_at: "2026-09-01T10:00:00.000Z",
  expires_at: null,
  revoked: false,
  expired: false,
  use_count: 3,
  ...over,
} as SettingsTokenRow);

function state(over: Partial<SettingsState> = {}): SettingsState {
  return {
    running: true,
    mcpUrl: "http://127.0.0.1:18080/mcp/abc",
    authEnabled: false,
    defaultTtlSeconds: 2592000,
    usableCount: 1,
    deadCount: 0,
    tokens: [token()],
    config: { "oauth.enabled": false, "oauth.allowedRedirectHosts": [] },
    ...over,
  } as unknown as SettingsState;
}

afterEach(() => { cleanup(); statusMock.mockReset(); });

describe("SecurityPage: one-time secrets survive an impatient click", () => {
  /**
   * Rotating mints a brand-new secret and invalidates the old one, and the
   * plaintext is shown exactly once. The create button is already disabled
   * while in flight, with a comment spelling out the consequence: a double
   * click minted two tokens and the first one's plaintext was overwritten,
   * leaving "an unauthenticated-forever token nobody could ever use".
   *
   * Rotate has the identical failure and had no guard at all. Two clicks =
   * two rotations: the secret the operator just copied is already dead, and
   * the dialog now shows a third value they may not have seen replace it.
   * Worse than the create case, because rotate also breaks a token that was
   * working a moment ago.
   */
  test("rotate cannot be fired twice while the first is in flight", async () => {
    statusMock.mockResolvedValue({ exposure: "local" });
    let resolveAct: (value: unknown) => void = () => {};
    const act = vi.fn().mockImplementation(() => new Promise(resolve => { resolveAct = resolve; }));

    render(<SecurityPage settings={state()} act={act} />);

    const rotate = await screen.findByText("轮换");
    fireEvent.click(rotate);
    fireEvent.click(rotate);
    fireEvent.click(rotate);

    const rotations = act.mock.calls.filter(([a]) => a.command === "rotateToken");
    expect(rotations).toHaveLength(1);

    resolveAct({ ok: true });
  });

  test("revoke-all and purge are likewise single-shot", async () => {
    // Same class: both are destructive, both were plain onClick handlers.
    statusMock.mockResolvedValue({ exposure: "local" });
    let resolveAct: (value: unknown) => void = () => {};
    const act = vi.fn().mockImplementation(() => new Promise(resolve => { resolveAct = resolve; }));

    render(<SecurityPage settings={state({ deadCount: 2 })} act={act} />);

    const purge = await screen.findByText("清理失效令牌");
    fireEvent.click(purge);
    fireEvent.click(purge);
    expect(act.mock.calls.filter(([a]) => a.command === "purgeTokens")).toHaveLength(1);

    resolveAct({ ok: true });
  });

  /**
   * The overview's 当前状态 row is derived server-side from auth.enabled
   * (meta-tools.ts: public + gate off = "public-open", gate on =
   * "public-authed"). The one-step arm button already re-read it, with a
   * comment saying the card must "stop describing the state we just left" --
   * but the plain Bearer switch a few centimetres below changes the same fact
   * and did not. Flipping it left the overview insisting the instance was
   * public-open, which is the one reading an operator acts on.
   */
  test("toggling the Bearer gate re-reads the exposure it changes", async () => {
    statusMock
      .mockResolvedValueOnce({ exposure: "public-open" })
      .mockResolvedValueOnce({ exposure: "public-authed" });
    const act = vi.fn().mockResolvedValue({ ok: true });

    render(<SecurityPage settings={state()} act={act} />);
    expect(await screen.findByText("public-open")).toBeTruthy();

    fireEvent.click(screen.getByLabelText("Bearer 门禁"));
    expect(act).toHaveBeenCalledWith({ command: "setAuthEnabled", enabled: true });

    expect(await screen.findByText("public-authed")).toBeTruthy();
  });
});

describe("SecurityPage: token timestamps", () => {
  test("created/expires render in local time, not the UTC string", async () => {
    // fmtDate used to slice the UTC ISO string, so a UTC+8 operator saw every
    // token's 创建/过期 eight hours off from the same page's other clocks.
    statusMock.mockResolvedValue({ exposure: "local" });
    render(<SecurityPage settings={state()} act={vi.fn()} />);
    const at = new Date("2026-09-01T10:00:00.000Z");
    const pad = (value: number): string => String(value).padStart(2, "0");
    const expected = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
    expect(await screen.findByText(expected)).toBeTruthy();
  });
});
