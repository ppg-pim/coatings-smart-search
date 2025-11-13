import { NextRequest, NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'

// Helper function to safely get string value
function getStringValue(obj: any, ...keys: string[]): string | null {
  for (const key of keys) {
    if (obj[key] && String(obj[key]).trim()) {
      return String(obj[key]).trim()
    }
  }
  return null
}

// Helper to get field value from coating
function getFieldValue(coating: any, fieldType: 'family' | 'type' | 'model'): string | null {
  let value = null

  try {
    if (fieldType === 'family') {
      value = getStringValue(coating, 'family', 'Family', 'product_family', 'productFamily')
      
      if (!value && coating.all_attributes) {
        const attr = typeof coating.all_attributes === 'string' 
          ? JSON.parse(coating.all_attributes) 
          : coating.all_attributes
        value = getStringValue(attr, 'family', 'Family', 'product_family', 'productFamily')
      }
    } else if (fieldType === 'type') {
      value = getStringValue(coating, 'product_type', 'productType', 'type', 'Type', 'category', 'Category')
      
      if (!value && coating.all_attributes) {
        const attr = typeof coating.all_attributes === 'string' 
          ? JSON.parse(coating.all_attributes) 
          : coating.all_attributes
        value = getStringValue(attr, 'product_type', 'productType', 'type', 'Type', 'category', 'Category')
      }
    } else if (fieldType === 'model') {
      value = getStringValue(coating, 'product_model', 'productModel', 'model', 'Model')
      
      if (!value && coating.all_attributes) {
        const attr = typeof coating.all_attributes === 'string' 
          ? JSON.parse(coating.all_attributes) 
          : coating.all_attributes
        value = getStringValue(attr, 'product_model', 'productModel', 'model', 'Model')
      }
    }
  } catch (e) {
    console.error('Error extracting field value:', e)
  }

  return value
}

// Extract unique values for each filter type
function extractFilterOptions(coatings: any[]) {
  const families = new Set<string>()
  const productTypes = new Set<string>()
  const productModels = new Set<string>()

  console.log(`🔍 Extracting filter options from ${coatings.length} coatings...`)

  coatings.forEach((coating, index) => {
    // Debug first coating
    if (index === 0) {
      console.log('📋 First coating sample:', {
        id: coating.id,
        name: coating.name || coating.product_name,
        fields: Object.keys(coating).slice(0, 20)
      })
    }

    const family = getFieldValue(coating, 'family')
    const type = getFieldValue(coating, 'type')
    const model = getFieldValue(coating, 'model')

    if (family) families.add(family)
    if (type) productTypes.add(type)
    if (model) productModels.add(model)
  })

  const result = {
    families: Array.from(families).sort(),
    productTypes: Array.from(productTypes).sort(),
    productModels: Array.from(productModels).sort()
  }

  console.log('✅ Extracted options:', {
    families: result.families.length,
    productTypes: result.productTypes.length,
    productModels: result.productModels.length
  })

  // Log samples
  if (result.families.length > 0) {
    console.log('📦 Sample families:', result.families.slice(0, 10))
  }
  if (result.productTypes.length > 0) {
    console.log('📦 Sample types:', result.productTypes.slice(0, 10))
  }
  if (result.productModels.length > 0) {
    console.log('📦 Sample models:', result.productModels.slice(0, 10))
  }

  return result
}

// Smart filtering
function filterCoatings(coatings: any[], filters: any) {
  if (!filters || (!filters.family && !filters.productType && !filters.productModel)) {
    return coatings
  }

  return coatings.filter(coating => {
    if (filters.family) {
      const familyValue = getFieldValue(coating, 'family')
      if (familyValue !== filters.family) return false
    }

    if (filters.productType) {
      const typeValue = getFieldValue(coating, 'type')
      if (typeValue !== filters.productType) return false
    }

    if (filters.productModel) {
      const modelValue = getFieldValue(coating, 'model')
      if (modelValue !== filters.productModel) return false
    }

    return true
  })
}

// GET handler - initial load
export async function GET() {
  try {
    console.log('🚀 GET /api/filter-options - Loading initial filter options...')

    // Try with a smaller limit first to see if it works
    const { data: coatings, error, count } = await supabase
      .from('coatings')
      .select('*', { count: 'exact' })
      .limit(1000) // Start with 1000 instead of 10000

    if (error) {
      console.error('❌ Supabase error:', error)
      throw new Error(`Database error: ${error.message}`)
    }

    console.log(`📦 Fetched ${coatings?.length || 0} coatings (total in DB: ${count})`)

    const { families, productTypes, productModels } = extractFilterOptions(coatings || [])

    return NextResponse.json({
      success: true,
      families,
      productTypes,
      productModels,
      totalCoatings: coatings?.length || 0,
      totalInDB: count
    })

  } catch (error: any) {
    console.error('❌ GET filter-options error:', error)
    
    return NextResponse.json(
      { 
        success: false,
        error: error.message || 'Failed to load filter options',
        families: [],
        productTypes: [],
        productModels: [],
        totalCoatings: 0
      },
      { status: 500 }
    )
  }
}

// POST handler - with filters
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { currentFilters } = body

    console.log('🚀 POST /api/filter-options - Current filters:', currentFilters)

    const { data: coatings, error } = await supabase
      .from('coatings')
      .select('*')
      .limit(1000)

    if (error) {
      console.error('❌ Supabase error:', error)
      throw new Error(`Database error: ${error.message}`)
    }

    console.log(`📦 Fetched ${coatings?.length || 0} coatings`)

    const filteredCoatings = filterCoatings(coatings || [], currentFilters)
    console.log(`🔍 After filtering: ${filteredCoatings.length} coatings`)

    const { families, productTypes, productModels } = extractFilterOptions(filteredCoatings)

    return NextResponse.json({
      success: true,
      families,
      productTypes,
      productModels,
      totalCoatings: filteredCoatings.length
    })

  } catch (error: any) {
    console.error('❌ POST filter-options error:', error)
    
    return NextResponse.json(
      { 
        success: false,
        error: error.message || 'Failed to load filter options',
        families: [],
        productTypes: [],
        productModels: [],
        totalCoatings: 0
      },
      { status: 500 }
    )
  }
}
