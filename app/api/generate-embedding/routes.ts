import { NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import OpenAI from 'openai'

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
})

export async function POST() {
  try {
    const { data: products, error } = await supabase
      .from('products')
      .select('*')
      .is('embedding', null)

    if (error) throw error

    for (const product of products || []) {
      // Create a text representation of the product
      const productText = Object.entries(product)
        .filter(([key]) => key !== 'embedding' && key !== 'id')
        .map(([key, value]) => `${key}: ${value}`)
        .join(', ')

      // Generate embedding
      const embeddingResponse = await openai.embeddings.create({
        model: 'text-embedding-3-small',
        input: productText,
      })

      const embedding = embeddingResponse.data[0].embedding

      // Update product with embedding
      await supabase
        .from('products')
        .update({ embedding })
        .eq('id', product.id)
    }

    return NextResponse.json({ success: true })
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
