// [REPRODUCTION, application SHA e432d3d] Baseline behaviour that the F201
// repair changes. This test DESCRIBES THE DEFECT and is expected to PASS on the
// unpatched source and FAIL on the repaired source.
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import "@/i18n";
import Overview from "@/pages/Overview";
import { useSessionStore } from "@/stores/sessionStore";

describe("repro: a refused /api/native-status is reported as a credential/DNS/listener measurement", () => {
  it("the empty defaults are rendered as measured facts", () => {
    // Exactly the state the client is in when /api/native-status answers 401
    // (or never answers): nothing measured, stores at their defaults.
    useSessionStore.setState({ native: null, fqdn: "", user: "", nativeLost: true, listenerOkFlag: false, runnerResolvedIP: "", runnerDnsOk: false });
    render(<MemoryRouter><Overview /></MemoryRouter>);
    const text = screen.getByTestId("overview-auto-login-note").textContent || "";
    // The three assertions the operator saw, none of which the server made:
    expect(text).toMatch(/FQDN\/user pair failed validation/i);
    expect(text).toMatch(/tailnet IP did not resolve/i);
    expect(text).toMatch(/LISTENER probe is not all green/i);
    // ...and nothing anywhere says the status read was refused.
    expect(document.body.textContent || "").not.toMatch(/no valid run key/i);
  });
});
