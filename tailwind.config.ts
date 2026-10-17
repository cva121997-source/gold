import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{js,ts,jsx,tsx,mdx}", "./components/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: { extend: { colors: { ink: "#20231f", gold: { 50: "#fbf8ee", 100: "#f4ebcd", 200: "#e9d69d", 300: "#d8b965", 400: "#c8a14b", 500: "#b58a32", 600: "#92702a", 700: "#715624" }, forest: { 50: "#edf5f0", 100: "#d6e9dc", 600: "#28734e", 700: "#1f5c3e", 800: "#194b33", 900: "#143c2a" } }, boxShadow: { soft: "0 8px 30px rgba(29, 35, 28, 0.07)" } } },
  plugins: []
};
export default config;
