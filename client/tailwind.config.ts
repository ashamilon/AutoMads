import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: "class",
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      colors: {
        surface: {
          50: "#f4f6fb",
          100: "#e8ecf6",
          200: "#d5ddf0",
          300: "#b4c0e3",
          400: "#8b9bd0",
          500: "#6376bd",
          600: "#4c5da8",
          700: "#3f4d8a",
          800: "#2f3a6b",
          900: "#1e2748",
          950: "#0c0f1a",
        },
        accent: {
          DEFAULT: "#6366f1",
          bright: "#818cf8",
          dim: "#4f46e5",
        },
        danger: "#f43f5e",
        success: "#34d399",
        warning: "#fbbf24",
      },
      fontFamily: {
        sans: ["var(--font-sans)", "system-ui", "sans-serif"],
        display: ["var(--font-display)", "var(--font-sans)", "system-ui", "sans-serif"],
        mono: ["var(--font-mono)", "ui-monospace", "monospace"],
      },
      letterSpacing: {
        display: "-0.035em",
        snug: "-0.02em",
      },
      fontSize: {
        /** Fluid marketing headline */
        "hero": ["clamp(2.25rem, 1.5rem + 3.5vw, 4.5rem)", { lineHeight: "1.05", letterSpacing: "-0.04em" }],
        "display-sm": ["clamp(1.75rem, 1.35rem + 1.5vw, 2.5rem)", { lineHeight: "1.12", letterSpacing: "-0.032em" }],
      },
      boxShadow: {
        glow: "0 0 80px -20px rgba(99, 102, 241, 0.45)",
        card: "0 4px 24px -4px rgba(0, 0, 0, 0.35), 0 0 0 1px rgba(255,255,255,0.04)",
      },
      backgroundImage: {
        "mesh-dark":
          "radial-gradient(at 40% 20%, rgba(99, 102, 241, 0.18) 0px, transparent 50%), radial-gradient(at 80% 0%, rgba(52, 211, 153, 0.12) 0px, transparent 45%), radial-gradient(at 0% 50%, rgba(244, 63, 94, 0.08) 0px, transparent 40%), linear-gradient(180deg, #07080f 0%, #0c0f1a 100%)",
        "grid-pattern":
          "linear-gradient(rgba(255,255,255,0.03) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.03) 1px, transparent 1px)",
      },
      backgroundSize: {
        grid: "64px 64px",
      },
    },
  },
  plugins: [],
};

export default config;
