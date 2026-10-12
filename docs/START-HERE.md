# Start here: My Reef in three steps

My Reef shows your Red Sea salinity and AquaWiz alkalinity together. You run it on a computer you keep switched on. Your phone can then show the same dashboard.

**You need:** a Mac or Windows computer with internet access, and your ReefBeat and/or AquaWiz login. You can connect either brand on its own. No Homebridge, Home Assistant or extra hub is needed.

## 1. Download and start

### Install Node.js once

[Download Node.js 24 LTS](https://nodejs.org/en/download). Choose the **installer** for your computer: `.pkg` for Mac or `.msi` for Windows. Open it and follow the installation steps. Node.js is the small program that runs My Reef on your computer.

### Start with one command — recommended

Open **Terminal** on Mac (find it with Spotlight) or **Command Prompt** on Windows (find it in the Start menu).

Copy this whole line, paste it into that window and press Enter:

```sh
npx --yes https://github.com/rudovjan/my-reef/archive/refs/tags/v0.2.0.tar.gz
```

This downloads and starts My Reef. First startup creates your login automatically. You do not need Git, Docker or an npm account. It should say **Open http://localhost:3000**.

Keep this command somewhere handy. Run the same line to start the app again later. Your password and saved equipment stay on your computer between starts and downloads.

### Prefer a downloaded folder? Use the ZIP instead

[Download My Reef as a ZIP](https://github.com/rudovjan/my-reef/archive/refs/heads/main.zip).

On Mac, open the ZIP to unpack it. On Windows, right-click the ZIP and choose **Extract All**. Open the extracted `my-reef-main` folder. Keep that folder somewhere convenient, such as Documents.

### Start the ZIP version

Double-click the start file for your computer:

| Your computer | File to open |
| --- | --- |
| Mac | **Start My Reef.command** |
| Windows | **Start My Reef.bat** |

A text window opens. First startup creates your My Reef login automatically. It should say **Open http://localhost:3000**. If it asks you to install Node.js, complete the installation above, then open the start file again.

### Sign in and connect your equipment

Open your browser on the **same computer** and enter **http://localhost:3000** in the address bar.

Copy the **My Reef login password** shown in the text window, paste it into the browser's password box and sign in. Keep that password private. The start window shows it again if you need it later.

Connect Red Sea using the same email and password you use in ReefBeat. Connect AquaWiz using your AquaWiz account. You should now see your readings. A KH reading changes when your tester performs a new test; refreshing the dashboard does not start a test.

**Leave the My Reef window open and keep the computer awake.** Closing that window stops the app. To start it again, run the same npx command or use the same Start My Reef file. Your password and saved connections are kept between starts.

### Is there an npx version?

Yes: the npx command above runs this project's tagged GitHub release. The shorter **`npx my-reef`** command needs publication to npm and is not available yet. Use the complete command shown above. People already comfortable with Docker can use the [Docker instructions](../README.md#docker) instead.

## 2. Access from your phone or away from home — optional

**Only using it on the computer where you started it? Skip this step.**

For phone access, My Reef currently needs an **HTTPS address**, including when the phone is on home Wi-Fi. This guide uses ngrok to provide that address. If you already have another HTTPS address for your My Reef installation, use it and go to step 3.

ngrok gives your running app a web address. It also lets you use it away from home. It does not move the app onto your phone: your computer still needs to stay on.

### Set up ngrok once

1. Create your own account at [ngrok](https://dashboard.ngrok.com/signup).
2. Follow the [ngrok installation instructions](https://ngrok.com/docs/gateway/endpoints/agent-cli-quickstart) for Mac or Windows. Open **Terminal** on Mac or **Command Prompt** on Windows when asked to enter a command.
3. On ngrok's [Your Authtoken](https://dashboard.ngrok.com/get-started/your-authtoken) page, copy the setup command it provides, paste it into that window and press Enter. Keep this token private.
4. Open [Domains](https://dashboard.ngrok.com/domains) and copy your assigned address. It looks like `your-name.ngrok-free.app` or `your-name.ngrok-free.dev`. Use your own address, not those examples.

### Tell My Reef its new address

Stop My Reef by pressing **Control+C** in its window.

If you started it with npx, paste this command into Terminal or Command Prompt and press Enter:

```sh
npx --yes https://github.com/rudovjan/my-reef/archive/refs/tags/v0.2.0.tar.gz phone
```

If you used the ZIP instead, double-click **Set Up Phone Access.command** on Mac or **Set Up Phone Access.bat** on Windows in the extracted folder.

Paste your ngrok address when asked, then press Enter. You can paste either the hostname or its full `https://` address. The helper saves the setting and shows the tunnel command you will need next. Copy that command.

Start My Reef again using your original npx command or Start My Reef file. Its window should now show your HTTPS address.

### Turn on the tunnel

Open a **second** Terminal or Command Prompt window. Paste the complete tunnel command shown by the phone-access helper, then press Enter. It will look like this, with your own address already filled in:

```sh
ngrok http http://127.0.0.1:3000 --url https://your-name.ngrok-free.app --inspect=false
```

Keep **both** windows open. On your phone, open that HTTPS address and sign in using your My Reef password. Once logged in, you should see the same readings as on the computer.

Use the HTTPS address from now on, including on the computer. With this setting, the app no longer accepts the old localhost dashboard address. ngrok's free plan may show a welcome page before My Reef and has [usage limits](https://ngrok.com/docs/pricing-limits/free-plan-limits).

If you use Docker, follow the [Docker + ngrok guide](NGROK.md) instead of the start-file instructions here.

## 3. Add My Reef to your home screen

First open your **working HTTPS address** on the phone and sign in. Add your own running dashboard, rather than this GitHub page or the localhost address.

### iPhone or iPad — Safari

1. Open the dashboard in **Safari**.
2. Tap **Share** (the square with an arrow pointing up). In some Safari layouts, open the page menu first, then Share.
3. Choose **Add to Home Screen**. You may need to scroll down.
4. If **Open as Web App** is shown, switch it on.
5. Keep the name **My Reef**, then tap **Add**.

You can now open the My Reef icon like an app. [Apple's instructions](https://support.apple.com/guide/iphone/iphea86e5236/ios)

### Android — Chrome

1. Open the dashboard in **Chrome**.
2. Tap the **three-dot menu** beside the address bar.
3. Choose **Install and create shortcut → Install**. Depending on Chrome's version, it may be called **Install app** or **Add to Home screen**.
4. Follow the prompts to add **My Reef**.

You can now open the My Reef icon from your home screen or app list. [Google's instructions](https://support.google.com/chrome/answer/9658361?co=GENIE.Platform%3DAndroid&hl=en)

The icon opens your dashboard; the computer continues to run it. Readings refresh when you open or return to the app. Your computer, internet connection and ngrok window must still be running. An installed icon does not keep your phone refreshing in the background.

## Next time

1. Start My Reef on your computer using the same npx command or start file.
2. If you use ngrok, open another Terminal or Command Prompt window and run the same tunnel command.
3. Tap My Reef on your phone.

Keep the same ngrok address so your home-screen icon keeps working. Share the repository with friends so they can set up their own copy. Sharing your dashboard address and password gives access to your own tank and saved connections.
