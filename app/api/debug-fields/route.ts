import { NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'

export async function GET() {
  try {
    const { data: coatings, error } = await supabase
      .from('coatings')
      .select('*')
      .limit(1)

    if (error) throw error

    const fields = coatings && coatings.length > 0 ? Object.keys(coatings[0]) : []
    const sample = coatings?.[0] || null

    return NextResponse.json({
      fields,
      sample
    })

  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
