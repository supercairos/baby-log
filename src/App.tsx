/**
 * Connection gate: splash while bootstrapping the persisted connection, the login screen
 * when signed out, the home shell when connected.
 */
import { Home } from "./app/Home";
import { LoginScreen } from "./app/LoginScreen";
import { useConnection } from "./app/hooks";
import { useStyles } from "./theme";

function Splash() {
  const { s } = useStyles();
  return (
    <div style={{ ...s.root, alignItems: "center", justifyContent: "center", minHeight: "100vh" }}>
      <div style={s.ambient} />
      <div className="spin" style={s.loginSpinner} />
    </div>
  );
}

export default function App() {
  const { state, connect, disconnect } = useConnection();
  if (state.status === "loading") return <Splash />;
  if (state.status === "out") return <LoginScreen onConnect={connect} />;
  return <Home client={state.client} onDisconnect={disconnect} />;
}
