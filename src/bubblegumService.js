const { createUmi } = require('@metaplex-foundation/umi-bundle-defaults');
const { mplBubblegum, mintV1 } = require('@metaplex-foundation/mpl-bubblegum');
const { keypairIdentity, publicKey } = require('@metaplex-foundation/umi');
const { fromWeb3JsKeypair } = require('@metaplex-foundation/umi-web3js-adapters');
const { Keypair, Connection } = require('@solana/web3.js');
const _bs58 = require('bs58'); const bs58 = _bs58.default || _bs58;
const { getDb } = require('./firebase');

const RPC_ENDPOINT = process.env.HELIUS_RPC_URL;
const MERKLE_TREE = process.env.MERKLE_TREE_ADDRESS;
const METADATA_BASE_URL = process.env.METADATA_BASE_URL;

function getTier(streakDay) {
  if (streakDay >= 365) return 'Diamond';
  if (streakDay >= 90)  return 'Platinum';
  if (streakDay >= 30)  return 'Gold';
  if (streakDay >= 14)  return 'Silver';
  return 'Bronze';
}

function buildMetadataUri(tier, streakDay) {
  return `${METADATA_BASE_URL}/cnft/${tier.toLowerCase()}/day-${streakDay}.json`;
}

function getUmi() {
  const umi = createUmi(RPC_ENDPOINT).use(mplBubblegum());
  const treasuryKeypair = Keypair.fromSecretKey(bs58.decode(process.env.TREASURY_PRIVATE_KEY));
  umi.use(keypairIdentity(fromWeb3JsKeypair(treasuryKeypair)));
  return umi;
}

async function mintDailyCheckinCNFT(walletAddress, streakDay) {
  const db = getDb();
  const today = new Date().toISOString().slice(0, 10);
  const mintDocId = `${walletAddress}_${today}`;

  const mintRef = db.collection('cnftMints').doc(mintDocId);
  const existing = await mintRef.get();
  if (existing.exists) {
    console.log(`cNFT already minted for ${walletAddress} on ${today}`);
    return { alreadyMinted: true, ...existing.data() };
  }

  const tier = getTier(streakDay);
  const uri = buildMetadataUri(tier, streakDay);
  const name = `SW Day ${streakDay} ${tier}`.slice(0, 32);
  const umi = getUmi();

  const { signature } = await mintV1(umi, {
    leafOwner: publicKey(walletAddress),
    merkleTree: publicKey(MERKLE_TREE),
    metadata: {
      name,
      uri,
      sellerFeeBasisPoints: 500,
      collection: null,
      creators: [{ address: umi.identity.publicKey, verified: false, share: 100 }],
    },
  }).sendAndConfirm(umi, { confirm: { commitment: 'confirmed' } });

  const txSig = Buffer.from(signature).toString('base64');
  const mintRecord = {
    walletAddress, streakDay, tier, name, uri,
    mintedAt: new Date(), date: today,
    txSignature: txSig, merkleTree: MERKLE_TREE, burned: false,
  };

  await mintRef.set(mintRecord);
  console.log(`cNFT minted → ${walletAddress} | Day ${streakDay} | ${tier}`);
  return { success: true, tier, streakDay, txSignature: txSig };
}

async function getUnburnedCNFTCount(walletAddress) {
  const db = getDb();
  const snap = await db.collection('cnftMints')
    .where('walletAddress', '==', walletAddress)
    .where('burned', '==', false)
    .get();
  return snap.size;
}

async function markCNFTsBurned(walletAddress, count = 30) {
  const db = getDb();
  const snap = await db.collection('cnftMints')
    .where('walletAddress', '==', walletAddress)
    .where('burned', '==', false)
    .orderBy('mintedAt', 'asc')
    .limit(count)
    .get();

  if (snap.size < count) throw new Error(`Not enough cNFTs: have ${snap.size}, need ${count}`);

  const batch = db.batch();
  const mintDocs = [];
  snap.docs.forEach(doc => {
    batch.update(doc.ref, { burned: true, burnedAt: new Date() });
    mintDocs.push(doc.data());
  });
  await batch.commit();
  return { success: true, burnedCount: snap.size, mintDocs };
}


const MYTHIC_DAYS = [30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330, 365];
const MYTHIC_FIGURES = {
  30: "Hercules", 60: "Achilles", 90: "Odysseus", 120: "Zeus",
  150: "Athena", 180: "Apollo", 210: "Ares", 240: "Poseidon",
  270: "Hades", 300: "Hera", 330: "Hermes", 365: "Prometheus"
};

async function mintMythicSBT(walletAddress, streakDay) {
  const figure = MYTHIC_FIGURES[streakDay];
  if (!figure) throw new Error("Not a mythic day: " + streakDay);
  const uri = `https://seekdaseek.github.io/solwatch/cnft/mythic/day-${streakDay}.json`;
  const name = `SW Mythic Day ${streakDay}`.slice(0, 32);
  const umi = getUmi();
  const { signature } = await mintV1(umi, {
    leafOwner: publicKey(walletAddress),
    merkleTree: publicKey(MERKLE_TREE),
    metadata: {
      name, uri, sellerFeeBasisPoints: 0, collection: null,
      creators: [{ address: umi.identity.publicKey, verified: false, share: 100 }],
    },
  }).sendAndConfirm(umi, { confirm: { commitment: "confirmed" } });
  const txSig = Buffer.from(signature).toString("base64");
  console.log(`Mythic SBT minted → ${walletAddress} | Day ${streakDay} | ${figure}`);
  return { success: true, figure, streakDay, txSignature: txSig };
}

module.exports = { mintDailyCheckinCNFT, mintMythicSBT, getUnburnedCNFTCount, markCNFTsBurned, getTier };
