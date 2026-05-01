export class ChatGPTStateManager {
  detectState(snapshot) {
    if (!snapshot) return 'UNKNOWN';

    // NOTE: Priority matters. Some pages render the chat shell/sidebar while an overlay/modal is present.
    // We must detect blocking overlays and special pages before generic CHAT_INTERFACE heuristics.

    // ONBOARDING overlays (can appear on top of chat/pricing/checkout)
    const isOnboarding =
      snapshot.includes('What brings you to ChatGPT?') ||
      snapshot.includes('What do you want to do with ChatGPT') ||
      snapshot.includes("You're all set") ||
      snapshot.includes('You’re all set') ||
      snapshot.includes('Okay, let’s go') ||
      snapshot.includes("Okay, let's go") ||
      snapshot.includes('Stay logged in') ||
      snapshot.includes('button "Get started"') ||
      snapshot.includes('Help us improve') ||
      // in-chat tour overlay
      (snapshot.includes('button "Skip Tour"') && snapshot.includes('button "Next"')) ||
      // generic "Skip" onboarding (avoid false positives on forms that have textboxes)
      ((snapshot.includes('button "Skip"') || snapshot.includes('button "Skip Tour"')) &&
        (snapshot.includes('button "Next"') ||
          snapshot.includes('heading "What brings you to ChatGPT?"') ||
          (snapshot.includes('button "Continue"') && !snapshot.includes('textbox'))));

    if (isOnboarding) return 'ONBOARDING';

    // ACCESS_DENIED / browser blocked
    if (
      snapshot.includes('Access denied') ||
      snapshot.includes('Reference #') ||
      /Your browser is out of date|Update your browser|Browser.*out of date/i.test(snapshot)
    ) {
      return 'ACCESS_DENIED';
    }

    // BLOCKED (Cloudflare / turnstile / interstitial)
    if (
      snapshot.includes('Just a moment...') ||
      snapshot.includes('Checking your browser') ||
      snapshot.includes('Checking your Browser') ||
      snapshot.includes('Verify you are human') ||
      snapshot.includes('Cloudflare security challenge') ||
      snapshot.includes('Widget containing a Cloudflare security challenge') ||
      snapshot.includes('checkbox "Verify you are human"')
    ) {
      return 'BLOCKED';
    }

    // AUTH_ERROR pages/overlays
    if (
      snapshot.includes('Oops, an error occurred') ||
      snapshot.includes('Something went wrong') ||
      snapshot.includes('An error occurred during authentication') ||
      snapshot.includes('There was an error when trying to log in') ||
      snapshot.includes('url="https://chatgpt.com/auth-error"')
    ) {
      return 'AUTH_ERROR';
    }

    // BUSINESS_TRIAL_PLAN_PICKER (seat selection / continue-to-billing step)
    if (
      snapshot.includes('Continue to billing') ||
      snapshot.includes('#team-pricing-seat-selection') ||
      snapshot.includes('team-pricing-seat-selection') ||
      (snapshot.includes('numSeats=') && snapshot.includes('selectedPlan='))
    ) {
      return 'BUSINESS_TRIAL_PLAN_PICKER';
    }

    // CHECKOUT
    if (
      snapshot.includes('/checkout') ||
      snapshot.includes('url="https://chatgpt.com/checkout') ||
      snapshot.includes('heading "Payment method"') ||
      snapshot.includes('StaticText "Start your free Business trial"') ||
      snapshot.includes('button "Subscribe"')
    ) {
      return 'CHECKOUT';
    }

    // PRICING
    // IMPORTANT: the logged-in chat shell can be at url="#pricing" without actually rendering the pricing modal.
    // We only classify PRICING when we see pricing-specific UI markers (modal or pricing content).
    if (
      snapshot.includes('heading "Upgrade your plan"') ||
      snapshot.includes('Upgrade your plan') ||
      snapshot.includes('Toggle for switching between Personal and Business plans') ||
      snapshot.includes('Upgrade to Business') ||
      snapshot.includes('Upgrade to Team') ||
      snapshot.includes('Try Business free for 1 month')
    ) {
      return 'PRICING';
    }

    // CHAT_INTERFACE
    if (
      snapshot.includes('StaticText "Ask anything"') ||
      snapshot.includes('What can I help with?') ||
      snapshot.includes('What’s on your mind today?') ||
      snapshot.includes("What's on your mind today?") ||
      snapshot.includes('What are you working on?') ||
      snapshot.includes('button "Open profile menu"') ||
      snapshot.includes('image "Profile image"') ||
      snapshot.includes('link "New chat') ||
      snapshot.includes('"New chat') ||
      (snapshot.includes('paragraph') && (snapshot.includes('prompt') || snapshot.includes('message')))
    ) {
      return 'CHAT_INTERFACE';
    }

    // ABOUT_YOU
    if (
      snapshot.includes("Let's confirm your age") ||
      snapshot.includes('textbox "Full name"') ||
      snapshot.includes('StaticText "Birthday"') ||
      snapshot.includes('StaticText "Date of birth"') ||
      snapshot.includes('Confirm your age')
    ) {
      return 'ABOUT_YOU';
    }

    // OTP_VERIFICATION
    if (
      snapshot.includes('textbox "Code"') ||
      snapshot.includes('textbox "Verification code"') ||
      snapshot.includes('heading "Check your inbox"') ||
      snapshot.includes('heading "Verify your email"') ||
      snapshot.includes('Verify your email to continue') ||
      snapshot.includes('Enter the code') ||
      snapshot.includes('StaticText "Verify your email"')
    ) {
      return 'OTP_VERIFICATION';
    }

    // LOGIN_PASSWORD
    if (
      snapshot.includes('textbox "Password"') ||
      snapshot.includes('heading "Create a password"') ||
      snapshot.includes('heading "Enter your password"')
    ) {
      return 'LOGIN_PASSWORD';
    }

    // LOGIN_EMAIL
    if (snapshot.includes('textbox "Email address"')) {
      return 'LOGIN_EMAIL';
    }

    // LANDING
    if (
      snapshot.includes('button "Sign up for free"') ||
      snapshot.includes('button "Log in"') ||
      snapshot.includes('link "Log in"') ||
      snapshot.includes('Your session has ended')
    ) {
      return 'LANDING';
    }

    return 'UNKNOWN';
  }
}
