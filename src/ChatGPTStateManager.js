export class ChatGPTStateManager {
  detectState(snapshot) {
    if (snapshot.includes("Let's confirm your age") || snapshot.includes('textbox "Full name"')) {
      return 'ABOUT_YOU';
    }
    if (snapshot.includes('textbox "Code"') || snapshot.includes('heading "Check your inbox"')) {
      return 'OTP_VERIFICATION';
    }
    if (snapshot.includes('textbox "Password"') || snapshot.includes('heading "Create a password"') || snapshot.includes('heading "Enter your password"')) {
      return 'LOGIN_PASSWORD';
    }
    if (snapshot.includes('textbox "Email address"') && !snapshot.includes('readonly')) {
      return 'LOGIN_EMAIL';
    }
    if (snapshot.includes('button "Sign up for free"') || snapshot.includes('button "Log in"')) {
      return 'LANDING';
    }
    if (snapshot.includes('You’re all set') || snapshot.includes('button "Skip"') || snapshot.includes('button "Next"') || snapshot.includes('Okay, let’s go') || (snapshot.includes('button "Continue"') && !snapshot.includes('textbox'))) {
      return 'ONBOARDING';
    }
    if (snapshot.includes('StaticText "Ask anything"') || snapshot.includes('What’s on your mind today') || (snapshot.includes('paragraph') && (snapshot.includes('prompt') || snapshot.includes('message')))) {
      return 'CHAT_INTERFACE';
    }
    if (snapshot.includes('Just a moment...') || snapshot.includes('Verify you are human')) {
      return 'BLOCKED';
    }
    return 'UNKNOWN';
  }
}
