import { program } from 'commander'
import { Wallet } from '@ethersproject/wallet'
import { JsonRpcProvider, TransactionReceipt } from '@ethersproject/providers'
import { BigNumber } from '@ethersproject/bignumber'
import { AddressZero } from '@ethersproject/constants'
import { getAddress } from '@ethersproject/address'
import fs from 'fs'
import deploy from './src/deploy'
import { MigrationState } from './src/migrations'
import { asciiStringToBytes32 } from './src/util/asciiStringToBytes32'
import { version } from './package.json'

program
  .requiredOption('-pk, --private-key <string>', 'Private key used to deploy all contracts')
  .requiredOption('-j, --json-rpc <url>', 'JSON RPC URL where the program should be deployed')
  .requiredOption('-w9, --weth9-address <address>', 'Address of the WETH9 contract on this chain')
  .requiredOption('-ncl, --native-currency-label <string>', 'Native currency label, e.g. ETH')
  .requiredOption(
    '-o, --owner-address <address>',
    'Contract address that will own the deployed artifacts after the script runs'
  )
  .option('-s, --state <path>', 'Path to the JSON file containing the migrations state (optional)', './state.json')
  .option('-v2, --v2-core-factory-address <address>', 'The V2 core factory address used in the swap router (optional)')
  .option('-g, --gas-price <number>', 'The gas price to pay in GWEI for each transaction (optional)')
  .option('--gas-price-wei <number>', 'The exact legacy gas price in wei (optional; cannot be combined with --gas-price)')
  .option('--gas-limit <number>', 'The gas limit to use for every transaction (optional)')
  .option('-c, --confirmations <number>', 'How many confirmations to wait for after each transaction (optional)', '2')

program.name('npx @uniswap/deploy-v3').version(version).parse(process.argv)

if (!/^0x[a-zA-Z0-9]{64}$/.test(program.privateKey)) {
  console.error('Invalid private key!')
  process.exit(1)
}

let url: URL
try {
  url = new URL(program.jsonRpc)
} catch (error) {
  console.error('Invalid JSON RPC URL', (error as Error).message)
  process.exit(1)
}

let gasPrice: BigNumber | undefined
try {
  if (program.gasPrice && program.gasPriceWei) {
    throw new Error('use either --gas-price or --gas-price-wei, not both')
  }
  gasPrice = program.gasPriceWei
    ? BigNumber.from(program.gasPriceWei)
    : program.gasPrice
    ? BigNumber.from(program.gasPrice).mul(BigNumber.from(10).pow(9))
    : undefined
} catch (error) {
  console.error('Failed to parse gas price', (error as Error).message)
  process.exit(1)
}

let gasLimit: BigNumber | undefined
try {
  gasLimit = program.gasLimit ? BigNumber.from(program.gasLimit) : undefined
} catch (error) {
  console.error('Failed to parse gas limit', (error as Error).message)
  process.exit(1)
}

let confirmations: number
try {
  confirmations = parseInt(program.confirmations)
} catch (error) {
  console.error('Failed to parse confirmations', (error as Error).message)
  process.exit(1)
}

let nativeCurrencyLabelBytes: string
try {
  nativeCurrencyLabelBytes = asciiStringToBytes32(program.nativeCurrencyLabel)
} catch (error) {
  console.error('Invalid native currency label', (error as Error).message)
  process.exit(1)
}

let weth9Address: string
try {
  weth9Address = getAddress(program.weth9Address)
} catch (error) {
  console.error('Invalid WETH9 address', (error as Error).message)
  process.exit(1)
}

let v2CoreFactoryAddress: string
if (typeof program.v2CoreFactoryAddress === 'undefined') {
  v2CoreFactoryAddress = AddressZero
} else {
  try {
    v2CoreFactoryAddress = getAddress(program.v2CoreFactoryAddress)
  } catch (error) {
    console.error('Invalid V2 factory address', (error as Error).message)
    process.exit(1)
  }
}

let ownerAddress: string
try {
  ownerAddress = getAddress(program.ownerAddress)
} catch (error) {
  console.error('Invalid owner address', (error as Error).message)
  process.exit(1)
}

const wallet = new Wallet(program.privateKey, new JsonRpcProvider({ url: url.href }))

let state: MigrationState
if (fs.existsSync(program.state)) {
  try {
    state = JSON.parse(fs.readFileSync(program.state, { encoding: 'utf8' }))
  } catch (error) {
    console.error('Failed to load and parse migration state file', (error as Error).message)
    process.exit(1)
  }
} else {
  state = {}
}

let finalState: MigrationState
const onStateChange = async (newState: MigrationState): Promise<void> => {
  const tempState = `${program.state}.tmp`
  fs.writeFileSync(tempState, JSON.stringify(newState))
  fs.renameSync(tempState, program.state)
  finalState = newState
}

async function run() {
  let step = 1
  const results = []
  const generator = deploy({
    signer: wallet,
    gasPrice,
    gasLimit,
    nativeCurrencyLabelBytes,
    v2CoreFactoryAddress,
    ownerAddress,
    weth9Address,
    initialState: state,
    onStateChange,
  })

  for await (const result of generator) {
    // Confirm BEFORE reporting. A step resolves as soon as its transaction is
    // submitted, and `address` is the CREATE address predicted from (sender,
    // nonce) rather than a deployed contract. Announcing first turns a dropped
    // transaction into a printed success followed by a silent 15-minute wait,
    // and writes the predicted address into the resume state for a contract
    // that does not exist.
    await Promise.all(
      result.map(
        async (stepResult): Promise<void> => {
          if (!stepResult.hash) return

          const receipt = await wallet.provider.waitForTransaction(
            stepResult.hash,
            confirmations,
            /* 15 minutes */ 1000 * 60 * 15
          )
          if (!receipt) {
            throw new Error(
              `Step ${step}: transaction ${stepResult.hash} was never mined within 15 minutes. ` +
                `It was most likely rejected at block production (Hydration drops an extrinsic ` +
                `at apply without producing a receipt). Nothing was deployed by this step.`
            )
          }
          if (receipt.status === 0) {
            throw new Error(
              `Step ${step}: transaction ${stepResult.hash} reverted (block ${receipt.blockNumber}, ` +
                `gasUsed ${receipt.gasUsed.toString()}). If gasUsed equals the gas limit this is an ` +
                `out-of-gas, not a logic revert.`
            )
          }
          // A CREATE step must leave code behind; the predicted address alone proves nothing.
          if (stepResult.address) {
            const code = await wallet.provider.getCode(stepResult.address)
            if (!code || code === '0x') {
              throw new Error(
                `Step ${step}: transaction ${stepResult.hash} succeeded but no code exists at ` +
                  `${stepResult.address}. The resume state must not record this address.`
              )
            }
          }
        }
      )
    )

    console.log(`Step ${step++} complete`, result)
    results.push(result)
  }

  return results
}

run()
  .then((results) => {
    console.log('Deployment succeeded')
    console.log(JSON.stringify(results))
    console.log('Final state')
    console.log(JSON.stringify(finalState))
    process.exit(0)
  })
  .catch((error) => {
    console.error('Deployment failed', error)
    console.log('Final state')
    console.log(JSON.stringify(finalState))
    process.exit(1)
  })
