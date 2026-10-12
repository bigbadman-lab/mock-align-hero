import { createContext, useContext } from "react";
import type { WalletView } from "./state";

// Default before the wallet runtime has loaded in the browser (and during SSR).
export const WalletContext = createContext<WalletView>({ status: "loading" });
export const useWallet = () => useContext(WalletContext);
