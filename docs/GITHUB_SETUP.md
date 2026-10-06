# Put Vantage online for free (GitHub Pages, about 10 minutes)

You need an HTTPS link, because phones only share GPS with secure pages. GitHub Pages gives you one free. All of this works from a phone browser. On a phone, use "Desktop site" mode if a menu is hidden.

1. Sign in, or sign up free, at **github.com**.
2. Tap **+ → New repository**. Name it `vantage`, choose **Public**, and tick **Add a README**. Then tap **Create repository**.
3. In the repo, tap **Add file → Upload files**. Upload `dist/index.html` from the zip; the file must be named `index.html`. Tap **Commit changes**.
   - *Optional:* also upload the whole project (src/, tests/, docs/) so the team's history lives on GitHub.
4. Go to **Settings → Pages**. Under **Build and deployment**, set Source to *Deploy from a branch*, Branch to `main`, and folder to `/ (root)`. Tap **Save**.
5. Wait about 1 minute. Your app is live at **`https://<your-username>.github.io/vantage/`**. Add it to your home screen (Share → Add to Home Screen).

To update it later, upload the new `index.html` over the old one. Pages redeploys automatically.

**Other ways to host it**
- **Netlify Drop** (app.netlify.com/drop): drag `index.html` in to get an instant HTTPS link (needs a computer).
- **Lovable**: Lovable is connected to your Claude account, so the team can deploy there instead. It uses your Lovable credits.
