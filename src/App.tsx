/**
 * Connection gate: splash while bootstrapping the persisted connection, the login screen
 * when signed out, the home shell when connected. The update prompt renders across all of
 * them so a new deploy is offered whatever the screen.
 */
import { Home } from "./app/Home";
import { LoginScreen } from "./app/LoginScreen";
import { UpdatePrompt } from "./app/UpdatePrompt";
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
  return (
    <>
      {state.status === "loading" ? (
        <Splash />
      ) : state.status === "out" ? (
        <LoginScreen onConnect={connect} />
      ) : (
        <Home client={state.client} connection={state.connection} onDisconnect={disconnect} />
      )}
      <UpdatePrompt />
    </>
  );
}
