// /api/swap-quote.js
// Endpoint untuk mendapatkan quote swap, mendukung:
//   - EVM: Ethereum mainnet (bisa ditambah Polygon/BSC/Arbitrum nanti)
//   - Solana
// Menggunakan 0x API (satu API key untuk semua chain). Fee otomatis
// dipotong ke wallet kamu lewat parameter swapFeeRecipient / swapFeeBps.
//
// ENV VARS yang wajib diset di Vercel:
//   ZEROX_API_KEY       -> API key dari dashboard.0x.org
//   FEE_WALLET_EVM       -> alamat wallet EVM kamu (0x...)
//   FEE_WALLET_SOLANA    -> alamat wallet Solana kamu
//
// Query params dari frontend:
//   chain        -> "ethereum" atau "solana"
//   sellToken    -> alamat/mint token yang dijual ("ETH" atau "SOL" untuk native token)
//   buyToken     -> alamat/mint token yang dibeli
//   sellAmount   -> jumlah yang dijual (base unit: wei untuk EVM, lamports untuk Solana)
//   takerAddress -> alamat wallet user yang connect

// Fee kamu dalam basis points. 30 bps = 0.3%.
const PLATFORM_FEE_BPS = 30;

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { chain, sellToken, buyToken, sellAmount, takerAddress } = req.query;

  if (!chain || !sellToken || !buyToken || !sellAmount) {
    return res.status(400).json({
      error: "Missing required params: chain, sellToken, buyToken, sellAmount",
    });
  }

  const apiKey = process.env.ZEROX_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "ZEROX_API_KEY belum diset di server" });
  }

  try {
    if (chain === "ethereum") {
      return await handleEvmQuote({ sellToken, buyToken, sellAmount, takerAddress, apiKey, res });
    }

    if (chain === "solana") {
      return await handleSolanaQuote({ sellToken, buyToken, sellAmount, takerAddress, apiKey, res });
    }

    return res.status(400).json({ error: `Chain '${chain}' belum didukung` });
  } catch (err) {
    console.error("Swap quote error:", err);
    return res.status(500).json({ error: "Gagal mengambil quote swap" });
  }
}

async function handleEvmQuote({ sellToken, buyToken, sellAmount, takerAddress, apiKey, res }) {
  const feeWallet = process.env.FEE_WALLET_EVM;
  if (!feeWallet) {
    return res.status(500).json({ error: "FEE_WALLET_EVM belum diset di server" });
  }

  const params = new URLSearchParams({
    chainId: "1", // Ethereum mainnet
    sellToken,
    buyToken,
    sellAmount,
    swapFeeRecipient: feeWallet,
    swapFeeBps: PLATFORM_FEE_BPS.toString(),
    swapFeeToken: buyToken,
  });

  if (takerAddress) params.append("taker", takerAddress);

  // AllowanceHolder flow: lebih simpel dari Permit2, cukup 1x approve (jika perlu)
  // + 1x kirim transaksi. Response sudah berisi transaction siap kirim.
  const response = await fetch(`https://api.0x.org/swap/allowance-holder/quote?${params.toString()}`, {
    headers: {
      "0x-api-key": apiKey,
      "0x-version": "v2",
    },
  });

  const data = await response.json();

  if (!response.ok) {
    return res.status(response.status).json({ error: data });
  }

  return res.status(200).json({
    chain: "ethereum",
    quote: data,
    estimatedFeeBps: PLATFORM_FEE_BPS,
  });
}

async function handleSolanaQuote({ sellToken, buyToken, sellAmount, takerAddress, apiKey, res }) {
  const feeWallet = process.env.FEE_WALLET_SOLANA;
  if (!feeWallet) {
    return res.status(500).json({ error: "FEE_WALLET_SOLANA belum diset di server" });
  }

  const params = new URLSearchParams({
    sellToken,
    buyToken,
    sellAmount,
    swapFeeRecipient: feeWallet,
    swapFeeBps: PLATFORM_FEE_BPS.toString(),
    swapFeeToken: buyToken,
  });

  if (takerAddress) params.append("taker", takerAddress);

  const response = await fetch(`https://api.0x.org/swap/solana/quote?${params.toString()}`, {
    headers: {
      "0x-api-key": apiKey,
      "0x-version": "v2",
    },
  });

  const data = await response.json();

  if (!response.ok) {
    return res.status(response.status).json({ error: data });
  }

  return res.status(200).json({
    chain: "solana",
    quote: data,
    estimatedFeeBps: PLATFORM_FEE_BPS,
  });
}
