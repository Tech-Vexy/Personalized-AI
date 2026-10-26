"use client";

import { useEffect, useState } from "react";
import GetStarted from "@/components/GetStarted";
import Onboarding from "@/components/Onboarding";
import ChatView from "@/components/ChatView";

export default function Page() {
  const [profileLoaded, setProfileLoaded] = useState(false);
  const [getStartedSeen, setGetStartedSeen] = useState(false);
  const [onboardingDone, setOnboardingDone] = useState(false);
  const [step, setStep] = useState<"get_started" | "onboarding" | "chat">("get_started");

  useEffect(() => {
    // 1. Fast local client check
    const localSeen = typeof window !== "undefined" && localStorage.getItem("personal_ai_get_started_seen") === "true";
    const localDone = typeof window !== "undefined" && localStorage.getItem("personal_ai_onboarding_done") === "true";
    if (localSeen) setGetStartedSeen(true);
    if (localDone) setOnboardingDone(true);

    // 2. Fetch server database state
    fetch("/api/profile")
      .then((res) => res.json())
      .then((data: { onboardingDone?: boolean; getStartedSeen?: boolean }) => {
        const seen = localSeen || data.getStartedSeen === true;
        const done = localDone || data.onboardingDone === true;
        setGetStartedSeen(seen);
        setOnboardingDone(done);
        if (done) {
          setStep("chat");
        } else if (seen) {
          setStep("chat");
        }
        setProfileLoaded(true);
      })
      .catch(() => {
        setProfileLoaded(true);
      });
  }, []);

  const handleStart = () => {
    if (typeof window !== "undefined") {
      localStorage.setItem("personal_ai_get_started_seen", "true");
    }
    setGetStartedSeen(true);
    setStep("onboarding");

    void fetch("/api/profile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "get_started_seen", value: "true" }),
    });
  };

  const handleSkip = () => {
    if (typeof window !== "undefined") {
      localStorage.setItem("personal_ai_get_started_seen", "true");
      localStorage.setItem("personal_ai_onboarding_done", "true");
    }
    setGetStartedSeen(true);
    setOnboardingDone(true);
    setStep("chat");

    void fetch("/api/profile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "get_started_seen", value: "true" }),
    });
    void fetch("/api/profile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "onboarding_done", value: "true" }),
    });
  };

  const handleOnboardingComplete = () => {
    if (typeof window !== "undefined") {
      localStorage.setItem("personal_ai_onboarding_done", "true");
    }
    setOnboardingDone(true);
    setStep("chat");
  };

  if (!profileLoaded) {
    return (
      <div className="app">
        <main className="chat-loading">
          <p>Loading…</p>
        </main>
      </div>
    );
  }

  // Get Started is shown only once on initial fresh launch
  if (!getStartedSeen && !onboardingDone && step === "get_started") {
    return <GetStarted onStart={handleStart} onSkip={handleSkip} />;
  }

  // If in onboarding step
  if (step === "onboarding" && !onboardingDone) {
    return <Onboarding onComplete={handleOnboardingComplete} />;
  }

  return <ChatView />;
}
