import fs from 'node:fs';

export type ParsedDocument = 
  | { type: 'document'; media_type: 'application/pdf'; data: string }
  | { type: 'image'; media_type: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif'; data: string };

export async function fetchAndParseDocument(url: string): Promise<ParsedDocument | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.warn(`Failed to fetch document ${url}: ${res.statusText}`);
      return null;
    }

    const buffer = Buffer.from(await res.arrayBuffer());
    const lowerUrl = url.toLowerCase();
    
    // PDF Parsing
    if (lowerUrl.includes('.pdf')) {
      return { type: 'document', media_type: 'application/pdf', data: buffer.toString('base64') };
    }
    
    // Image Parsing (Base64)
    if (lowerUrl.includes('.jpg') || lowerUrl.includes('.jpeg')) {
      return { type: 'image', media_type: 'image/jpeg', data: buffer.toString('base64') };
    }
    if (lowerUrl.includes('.png')) {
      return { type: 'image', media_type: 'image/png', data: buffer.toString('base64') };
    }
    if (lowerUrl.includes('.webp')) {
      return { type: 'image', media_type: 'image/webp', data: buffer.toString('base64') };
    }
    if (lowerUrl.includes('.gif')) {
      return { type: 'image', media_type: 'image/gif', data: buffer.toString('base64') };
    }

    console.warn(`Unsupported document type for URL: ${url}`);
    return null;
  } catch (err) {
    console.error(`Error parsing document ${url}:`, err);
    return null;
  }
}
