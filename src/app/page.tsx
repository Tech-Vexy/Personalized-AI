"use client";

import { useEffect, useState } from "react";
import GetStarted from "@/components/GetStarted";
import Onboarding from "@/components/Onboarding";
import ChatView from "@/components/ChatView";

export default function Page() {
  const [onboardingDone, setOnboardingDone] = useState<boolean | null>(null);
  const [step, setStep] = useState<"get_started" | "onboarding">("get_started");

  useEffect(() => {
    fetch("/api/profile")
      .then((res) => res.json())
      .then((data: { onboardingDone?: boolean }) => {
        setOnboardingDone(data.onboardingDone === true);
      })
      .catch(() => {
        setOnboardingDone(false);
      });
  }, []);

  if (onboardingDone === null) {
    return (
      <div className="app">
        <main className="chat-loading">
          <p>Loading…</p>
        </main>
      </div>
    );
  }

  if (!onboardingDone) {
    if (step === "get_started") {
      return <GetStarted onStart={() => setStep("onboarding")} />;
    }
    return <Onboarding onComplete={() => setOnboardingDone(true)} />;
  }

  return <ChatView />;
}
