/* Webpack-configuratie: bouwt het taakvenster naar dist/ en serveert het
   tijdens ontwikkeling op https://localhost:3000 met de Office-dev-certificaten. */
const path = require("path");
const HtmlWebpackPlugin = require("html-webpack-plugin");
const CopyWebpackPlugin = require("copy-webpack-plugin");

async function httpsOptions() {
  // Alleen nodig voor de dev-server; laadt de lokale certificaten van office-addin-dev-certs.
  const devCerts = require("office-addin-dev-certs");
  const opts = await devCerts.getHttpsServerOptions();
  return { ca: opts.ca, key: opts.key, cert: opts.cert };
}

module.exports = async (env, argv) => {
  const dev = argv.mode === "development";
  return {
    devtool: dev ? "source-map" : false,
    entry: { taskpane: "./src/taskpane/taskpane.ts" },
    output: { path: path.resolve(__dirname, "dist"), filename: "[name].js", clean: true },
    resolve: { extensions: [".ts", ".js"] },
    module: { rules: [{ test: /\.ts$/, use: "ts-loader", exclude: /node_modules/ }] },
    plugins: [
      new HtmlWebpackPlugin({
        filename: "taskpane.html",
        template: "./src/taskpane/taskpane.html",
        chunks: ["taskpane"],
      }),
      new CopyWebpackPlugin({
        patterns: [
          { from: "assets", to: "assets" },
          { from: "src/taskpane/taskpane.css", to: "taskpane.css" },
        ],
      }),
    ],
    devServer: dev
      ? {
          port: 3000,
          headers: { "Access-Control-Allow-Origin": "*" },
          server: { type: "https", options: await httpsOptions() },
        }
      : undefined,
  };
};
