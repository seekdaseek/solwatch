require('dotenv').config();
const { createUmi } = require('@metaplex-foundation/umi-bundle-defaults');
const { mplBubblegum, createTree } = require('@metaplex-foundation/mpl-bubblegum');
const { keypairIdentity, generateSigner } = require('@metaplex-foundation/umi');
const { fromWeb3JsKeypair } = require('@metaplex-foundation/umi-web3js-adapters');
const { Keypair } = require('@solana/web3.js');
const bs58 = require('bs58');

const decode = bs58.default?.decode ?? bs58.decode;

async function main() {
  const umi = createUmi(process.env.HELIUS_RPC_URL).use(mplBubblegum());
  const treasuryKeypair = Keypair.fromSecretKey(decode(process.env.TREASURY_PRIVATE_KEY.trim()));
  umi.use(keypairIdentity(fromWeb3JsKeypair(treasuryKeypair)));

  const merkleTree = generateSigner(umi);
  console.log('Creating merkle tree...');
  console.log('Tree address will be:', merkleTree.publicKey);

  const builder = await createTree(umi, {
    merkleTree,
    maxDepth: 14,
    maxBufferSize: 64,
  });

  await builder.sendAndConfirm(umi);

  console.log('✅ Merkle tree created:', merkleTree.publicKey);
  console.log('Add this to your .env:');
  console.log(`MERKLE_TREE_ADDRESS=${merkleTree.publicKey}`);
}

main().catch(console.error);
