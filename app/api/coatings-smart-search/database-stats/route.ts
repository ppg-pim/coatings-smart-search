import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!

const supabase = createClient(supabaseUrl, supabaseKey)

export async function GET(request: NextRequest) {
  try {
    console.log('📊 Fetching database statistics...')
    
    // Get total count
    const { count: totalCount, error: countError } = await supabase
      .from('coatings')
      .select('*', { count: 'exact', head: true })
    
    if (countError) {
      throw countError
    }
    
    console.log(`✅ Total products: ${totalCount}`)
    
    // Fetch all data in batches to get accurate unique counts
    const BATCH_SIZE = 1000
    const totalBatches = Math.ceil((totalCount || 0) / BATCH_SIZE)
    
    const allFamilies = new Set<string>()
    const allTypes = new Set<string>()
    const allModels = new Set<string>()
    const allSkus = new Set<string>()
    
    console.log(`📥 Fetching ${totalBatches} batches...`)
    
    for (let i = 0; i < totalBatches; i++) {
      const from = i * BATCH_SIZE
      const to = from + BATCH_SIZE - 1
      
      const { data, error } = await supabase
        .from('coatings')
        .select('family, Product_Type, Product_Model, sku')
        .range(from, to)
      
      if (error) {
        console.error(`❌ Error fetching batch ${i + 1}:`, error)
        continue
      }
      
      if (data) {
        data.forEach(row => {
          if (row.family) allFamilies.add(row.family)
          if (row.Product_Type) allTypes.add(row.Product_Type)
          if (row.Product_Model) allModels.add(row.Product_Model)
          if (row.sku) allSkus.add(row.sku)
        })
      }
      
      if ((i + 1) % 10 === 0 || i === totalBatches - 1) {
        console.log(`   ✅ Processed batch ${i + 1}/${totalBatches}`)
      }
    }
    
    const stats = {
      total_families: allFamilies.size,
      total_products: totalCount,
      total_product_types: allTypes.size,
      total_product_models: allModels.size,
      total_skus: allSkus.size
    }
    
    console.log('📊 Final statistics:', stats)
    
    return NextResponse.json({
      success: true,
      timestamp: new Date().toISOString(),
      statistics: stats,
      families: Array.from(allFamilies).sort(),
      productTypes: Array.from(allTypes).sort(),
      productModels: Array.from(allModels).sort()
    })
    
  } catch (error: any) {
    console.error('❌ Error:', error)
    return NextResponse.json(
      { 
        success: false,
        error: error.message 
      },
      { status: 500 }
    )
  }
}
