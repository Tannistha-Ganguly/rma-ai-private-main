import { NextResponse } from 'next/server';

export async function GET() {
  return NextResponse.json({
    status: 'ok',
    service: 'rma-ai',
    version: process.env.npm_package_version ?? '0.1.0',
    time: new Date().toISOString(),
  });
}
