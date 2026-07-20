import { describe, expect, test } from "vitest";
import { loginPlanForAccount } from "../src/login-plan";

describe("loginPlanForAccount", () => {
  test("native account: plain `claude auth login`, CLAUDE_CONFIG_DIR explicitly unset", () => {
    const p = loginPlanForAccount({ id: "claw1", native: true });
    expect(p.command).toEqual(["claude", "auth", "login"]);
    expect(p.clearConfigDir).toBe(true); // must target the DEFAULT dir/keychain
    expect(p.configDir).toBeUndefined();
    expect(p.verify).toBe("auth-status");
  });

  test("dir-login account: auth login inside the isolated dir, dir created first", () => {
    const p = loginPlanForAccount({ id: "claw2", configDir: "~/.claw2" });
    expect(p.command).toEqual(["claude", "auth", "login"]);
    expect(p.configDir).toBe("~/.claw2");
    expect(p.ensureDir).toBe(true);
    expect(p.verify).toBe("auth-status");
  });

  test("secret-ref account: setup-token in the isolated dir; token goes to the vault, never captured", () => {
    const p = loginPlanForAccount({
      id: "claw2",
      configDir: "~/.claw2",
      oauthTokenRef: { source: "exec", provider: "onepassword", id: "op://V/I/f" },
    });
    expect(p.command).toEqual(["claude", "setup-token"]);
    expect(p.configDir).toBe("~/.claw2");
    expect(p.verify).toBe("manual");
    expect(p.afterNote).toMatch(/onepassword/);
    expect(p.afterNote).toMatch(/secret reference|vault|item/i);
  });

  test("token-file account: setup-token, note says where to save and chmod", () => {
    const p = loginPlanForAccount({
      id: "claw2",
      configDir: "~/.claw2",
      oauthTokenFile: "~/.claw2/oauth-token",
    });
    expect(p.command).toEqual(["claude", "setup-token"]);
    expect(p.verify).toBe("token-file");
    expect(p.afterNote).toContain("~/.claw2/oauth-token");
    expect(p.afterNote).toMatch(/600/);
  });

  test("ref account without a configDir still works (env-only token account)", () => {
    const p = loginPlanForAccount({
      id: "claw3",
      oauthTokenRef: { source: "exec", provider: "onepassword", id: "op://V/I/f" },
    });
    expect(p.command).toEqual(["claude", "setup-token"]);
    expect(p.configDir).toBeUndefined();
    // no dir of its own — token capture must not touch the DEFAULT login either,
    // so the run gets a throwaway scratch config dir
    expect(p.scratchDir).toBe(true);
    expect(p.warn).toMatch(/temporary|scratch/i);
  });
});
