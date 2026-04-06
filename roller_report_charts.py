#!/usr/bin/env python3
"""
Boggy Creek Airboats — Daily Roller Report with Inline Charts
Generates an HTML email with matplotlib charts (base64 inline PNGs)
and sends via Gmail SMTP (smtplib).
"""

import argparse
import base64
import io
import os
import smtplib
import sys
from datetime import datetime, timedelta
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from pathlib import Path

from dotenv import load_dotenv
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import matplotlib.patches as mpatches
import numpy as np


# ── Sample data (used with --test) ──────────────────────────────────────────

def get_sample_data():
    today = datetime.now()
    days = [(today - timedelta(days=6-i)).strftime("%a") for i in range(7)]
    return {
        "revenue_labels": days,
        "revenue_values": [4200, 3800, 5100, 4600, 6200, 8400, 3629],
        "channel_labels": ["Direct", "TripAdvisor", "GetYourGuide", "ATD Travel", "GoCity", "Other"],
        "channel_values": [45, 22, 18, 8, 4, 3],
        "checkin_labels": days,
        "checkin_values": [72, 68, 89, 95, 110, 143, 84],
        "gx_score": 86,
        "today_guests": 448,
        "today_revenue": 3629,
        "today_funds": 5170,
        "today_checkins": 84,
        "roller_balance": 77303,
    }


# ── Chart generators ────────────────────────────────────────────────────────

BG = "#0a0a0f"
TEAL = "#00E5FF"
TEAL_DIM = "#007a8a"
WHITE = "#e0e0e0"
GRID = "#1a1a2e"


def _fig_to_base64(fig):
    buf = io.BytesIO()
    fig.savefig(buf, format="png", dpi=110, bbox_inches="tight",
                facecolor=fig.get_facecolor(), edgecolor="none")
    plt.close(fig)
    buf.seek(0)
    return base64.b64encode(buf.read()).decode("utf-8")


def chart_revenue(labels, values):
    fig, ax = plt.subplots(figsize=(5.5, 3.2))
    fig.set_facecolor(BG)
    ax.set_facecolor(BG)

    colors = [TEAL_DIM] * (len(values) - 1) + [TEAL]
    bars = ax.bar(labels, values, color=colors, width=0.6, edgecolor="none")

    for bar, val in zip(bars, values):
        ax.text(bar.get_x() + bar.get_width()/2, bar.get_height() + 120,
                f"${val:,.0f}", ha="center", va="bottom", color=WHITE,
                fontsize=8, fontweight="bold")

    ax.set_ylim(0, max(values) * 1.25)
    ax.set_ylabel("Revenue ($)", color=WHITE, fontsize=9)
    ax.set_title("7-Day Revenue", color=TEAL, fontsize=12, fontweight="bold", pad=10)
    ax.tick_params(colors=WHITE, labelsize=8)
    ax.spines[:].set_visible(False)
    ax.yaxis.set_visible(False)
    ax.grid(axis="y", color=GRID, linewidth=0.5)
    return _fig_to_base64(fig)


def chart_channels(labels, values):
    fig, ax = plt.subplots(figsize=(4.5, 3.2))
    fig.set_facecolor(BG)
    ax.set_facecolor(BG)

    palette = ["#00E5FF", "#00B8D4", "#0097A7", "#00796B", "#4DB6AC", "#80CBC4"]
    explode = [0.03] * len(labels)

    wedges, texts, autotexts = ax.pie(
        values, labels=None, autopct="%1.0f%%", startangle=140,
        colors=palette[:len(labels)], explode=explode,
        textprops={"color": WHITE, "fontsize": 8},
        pctdistance=0.78)

    for t in autotexts:
        t.set_fontweight("bold")

    ax.legend(wedges, labels, loc="center left", bbox_to_anchor=(0.95, 0.5),
              fontsize=7, facecolor=BG, edgecolor=GRID, labelcolor=WHITE,
              framealpha=0.9)
    ax.set_title("Bookings by Channel", color=TEAL, fontsize=12,
                 fontweight="bold", pad=10)
    return _fig_to_base64(fig)


def chart_checkins(labels, values):
    fig, ax = plt.subplots(figsize=(5.5, 3.2))
    fig.set_facecolor(BG)
    ax.set_facecolor(BG)

    x = np.arange(len(labels))
    ax.fill_between(x, values, alpha=0.25, color=TEAL)
    ax.plot(x, values, color=TEAL, linewidth=2.5, marker="o",
            markersize=6, markerfacecolor=TEAL, markeredgecolor=WHITE,
            markeredgewidth=1.2)

    for i, v in enumerate(values):
        ax.text(i, v + 4, str(v), ha="center", va="bottom",
                color=WHITE, fontsize=8, fontweight="bold")

    ax.set_xticks(x)
    ax.set_xticklabels(labels)
    ax.set_ylim(0, max(values) * 1.3)
    ax.set_title("Daily Check-ins (7 days)", color=TEAL, fontsize=12,
                 fontweight="bold", pad=10)
    ax.tick_params(colors=WHITE, labelsize=8)
    ax.spines[:].set_visible(False)
    ax.yaxis.set_visible(False)
    ax.grid(axis="y", color=GRID, linewidth=0.5)
    return _fig_to_base64(fig)


def chart_gx_gauge(score):
    fig, ax = plt.subplots(figsize=(3.5, 2.5), subplot_kw={"projection": "polar"})
    fig.set_facecolor(BG)
    ax.set_facecolor(BG)

    # Semi-circle gauge: 0-100 mapped to pi..0
    zones = [
        (0, 40, "#e53935"),    # red
        (40, 70, "#FFC107"),   # yellow
        (70, 100, "#00E676"),  # green
    ]
    for lo, hi, color in zones:
        theta_start = np.pi * (1 - lo / 100)
        theta_end = np.pi * (1 - hi / 100)
        theta = np.linspace(theta_start, theta_end, 50)
        ax.fill_between(theta, 0.7, 1.0, color=color, alpha=0.35)

    # Needle
    needle_angle = np.pi * (1 - score / 100)
    ax.plot([needle_angle, needle_angle], [0, 0.9], color=TEAL,
            linewidth=3, solid_capstyle="round")
    ax.plot(needle_angle, 0.9, "o", color=TEAL, markersize=6)

    # Score text
    ax.text(np.pi / 2, 0.15, f"{score}", ha="center", va="center",
            fontsize=28, fontweight="bold", color=TEAL,
            transform=ax.transData)
    ax.text(np.pi / 2, -0.15, "/100", ha="center", va="center",
            fontsize=11, color=WHITE, alpha=0.7,
            transform=ax.transData)

    ax.set_ylim(0, 1.1)
    ax.set_thetamin(0)
    ax.set_thetamax(180)
    ax.set_theta_direction(-1)
    ax.set_theta_offset(np.pi)
    ax.axis("off")
    ax.set_title("GX Score", color=TEAL, fontsize=12, fontweight="bold",
                 pad=10, y=1.05)
    return _fig_to_base64(fig)


# ── HTML builder ────────────────────────────────────────────────────────────

def build_html(data):
    rev_b64 = chart_revenue(data["revenue_labels"], data["revenue_values"])
    chan_b64 = chart_channels(data["channel_labels"], data["channel_values"])
    chk_b64 = chart_checkins(data["checkin_labels"], data["checkin_values"])
    gx_b64 = chart_gx_gauge(data["gx_score"])

    today_str = datetime.now().strftime("%A, %B %d, %Y")

    def metric_card(label, value):
        return f"""
        <td style="padding:8px 12px;text-align:center;">
          <div style="font-size:24px;font-weight:bold;color:#00E5FF;">{value}</div>
          <div style="font-size:11px;color:#aaa;margin-top:2px;">{label}</div>
        </td>"""

    html = f"""<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Boggy Creek Daily Report</title></head>
<body style="margin:0;padding:0;background:#0a0a0f;font-family:'Segoe UI',Helvetica,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#0a0a0f;">
<tr><td align="center" style="padding:20px 10px;">
<table width="640" cellpadding="0" cellspacing="0" style="max-width:640px;width:100%;">

  <!-- Header -->
  <tr><td style="padding:24px 30px;text-align:center;border-bottom:2px solid #00E5FF;">
    <div style="font-size:28px;font-weight:bold;color:#00E5FF;letter-spacing:2px;">
      &#x1F40A; BOGGY CREEK AIRBOATS
    </div>
    <div style="font-size:13px;color:#888;margin-top:6px;">Daily Performance Report &mdash; {today_str}</div>
  </td></tr>

  <!-- KPI Cards -->
  <tr><td style="padding:20px 10px 10px;">
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#111118;border-radius:10px;border:1px solid #1a1a2e;">
    <tr>
      {metric_card("Guests Booked", f'{data["today_guests"]:,}')}
      {metric_card("Today Revenue", f'${data["today_revenue"]:,.0f}')}
      {metric_card("Funds Received", f'${data["today_funds"]:,.0f}')}
      {metric_card("Check-ins", f'{data["today_checkins"]:,}')}
      {metric_card("Roller Balance", f'${data["roller_balance"]:,.0f}')}
    </tr></table>
  </td></tr>

  <!-- Revenue + Channels -->
  <tr><td style="padding:10px;">
    <table width="100%" cellpadding="0" cellspacing="0"><tr>
      <td width="55%" style="padding-right:6px;">
        <img src="data:image/png;base64,{rev_b64}" width="100%" style="display:block;border-radius:8px;" alt="Revenue Chart">
      </td>
      <td width="45%" style="padding-left:6px;">
        <img src="data:image/png;base64,{chan_b64}" width="100%" style="display:block;border-radius:8px;" alt="Channel Chart">
      </td>
    </tr></table>
  </td></tr>

  <!-- Check-ins + GX Score -->
  <tr><td style="padding:10px;">
    <table width="100%" cellpadding="0" cellspacing="0"><tr>
      <td width="60%" style="padding-right:6px;">
        <img src="data:image/png;base64,{chk_b64}" width="100%" style="display:block;border-radius:8px;" alt="Check-ins Chart">
      </td>
      <td width="40%" style="padding-left:6px;vertical-align:middle;">
        <img src="data:image/png;base64,{gx_b64}" width="100%" style="display:block;border-radius:8px;" alt="GX Score">
      </td>
    </tr></table>
  </td></tr>

  <!-- Footer -->
  <tr><td style="padding:20px 30px;text-align:center;border-top:1px solid #1a1a2e;">
    <div style="font-size:11px;color:#555;">
      Automated report &bull; Boggy Creek Airboats &bull; Powered by ClearPath Apps
    </div>
  </td></tr>

</table>
</td></tr></table>
</body></html>"""
    return html


# ── Email sender (Gmail SMTP via smtplib) ───────────────────────────────────

SMTP_SERVER = "smtp.gmail.com"
SMTP_PORT = 587
TO_ADDR = "chrispark@bcairboats.com"
CC_ADDRS = ["skirscht@bcairboats.com", "allen@clearpathapps.ai"]


def send_email(html, to=TO_ADDR, cc=None):
    if cc is None:
        cc = CC_ADDRS

    # Load credentials from .env
    env_path = Path(__file__).resolve().parent / ".env"
    load_dotenv(env_path)
    gmail_user = os.getenv("GMAIL_USER")
    gmail_pass = os.getenv("GMAIL_APP_PASSWORD")

    if not gmail_user or not gmail_pass:
        print("ERROR: GMAIL_USER and GMAIL_APP_PASSWORD must be set in .env")
        print(f"  Expected .env at: {env_path}")
        sys.exit(1)

    subject = f"🐊 Boggy Creek Daily Report — {datetime.now().strftime('%B %d, %Y')}"

    # Build MIME message
    msg = MIMEMultipart("alternative")
    msg["From"] = gmail_user
    msg["To"] = to
    msg["Cc"] = ", ".join(cc)
    msg["Subject"] = subject
    msg.attach(MIMEText(html, "html"))

    all_recipients = [to] + cc

    print(f"Sending report to {to} (cc: {', '.join(cc)})...")
    try:
        with smtplib.SMTP(SMTP_SERVER, SMTP_PORT) as server:
            server.ehlo()
            server.starttls()
            server.ehlo()
            server.login(gmail_user, gmail_pass)
            server.sendmail(gmail_user, all_recipients, msg.as_string())
        print(f"✓ Report sent to {to} + {len(cc)} CC")
    except smtplib.SMTPAuthenticationError:
        print("ERROR: Gmail authentication failed.")
        print("  Check GMAIL_APP_PASSWORD in .env (must be a Gmail App Password, not your regular password)")
        print("  Create one at: myaccount.google.com → Security → App Passwords")
        sys.exit(1)
    except Exception as e:
        print(f"ERROR: Failed to send email: {e}")
        sys.exit(1)


# ── Main ────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Boggy Creek Airboats — Daily Roller Report")
    parser.add_argument("--test", action="store_true",
                        help="Send report with sample data (no Roller login needed)")
    parser.add_argument("--to", default="chrispark@bcairboats.com",
                        help="Override recipient email")
    parser.add_argument("--save-html", metavar="FILE",
                        help="Save HTML to file instead of sending")
    args = parser.parse_args()

    if args.test:
        print("Running in TEST mode with sample data...")
        data = get_sample_data()
    else:
        # TODO: Wire in live Roller API data
        print("Live Roller data not yet wired — falling back to sample data")
        data = get_sample_data()

    print("Generating charts...")
    html = build_html(data)
    print(f"✓ HTML generated ({len(html):,} bytes, 4 inline charts)")

    if args.save_html:
        with open(args.save_html, "w") as f:
            f.write(html)
        print(f"✓ Saved to {args.save_html}")
        return

    send_email(html, to=args.to)


if __name__ == "__main__":
    main()
