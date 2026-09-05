import './style.css'

const $checkBtn: HTMLButtonElement = document.querySelector<HTMLButtonElement>('#check-btn')!
const $connectBtn: HTMLButtonElement = document.querySelector<HTMLButtonElement>('#connect-btn')!

let device: BluetoothDevice | undefined

$checkBtn.addEventListener('click', async () => {
  device = await getDevice()

  console.log(device)

  $connectBtn.disabled = false
  $connectBtn.textContent = `Connect to ${device?.name ?? 'device'}`
})

$connectBtn.addEventListener('click', async () => {
  if (!device) return

  const gatt = await device.gatt.connect()

  console.log(device.name, gatt)
})

document.addEventListener('DOMContentLoaded', async () => {
  if (!('serial' in navigator)) {
    console.log('Web Serial API not available')
    return
  }

  // needs HTTPS or localhost, and a user gesture for the permission prompt
  const ports = await navigator.serial.getPorts()
  console.log(ports)

  //
})

async function getDevice(): Promise<BluetoothDevice | undefined> {
  if (!await navigator.bluetooth.getAvailability()) {
    console.log('bluetooth not available')
    return undefined;
  }

  const device = await navigator.bluetooth.requestDevice({
    acceptAllDevices: true,
  })

  return device
}
